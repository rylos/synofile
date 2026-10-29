//! The transfer daemon: started with the package, it keeps the jobs, runs
//! their workers and remembers how each one went, so a transfer goes on
//! when the browser closes and its dialog, opened again, shows the whole
//! history. The CGI talks to it over a Unix socket only the package user
//! can open.

use std::collections::VecDeque;
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{ChildStdin, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::protocol::{Command, ConflictInfo, Event, Op, Policy, Progress, Spec, Status};
use crate::identity::User;

const MAX_PARALLEL: usize = 2;
const SAMPLE_EVERY: Duration = Duration::from_millis(500);
const MAX_SAMPLES: usize = 2400;
const MAX_ERRORS: usize = 500;
const KEEP_FINISHED: Duration = Duration::from_secs(24 * 3600);
const MAX_JOBS: usize = 200;

pub fn socket_path() -> PathBuf {
    crate::var_dir().join("transfers.sock")
}

/// What the interface shows about the job, besides the progress.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Info {
    pub sources: Vec<String>,
    pub dest: Option<String>,
    #[serde(default)]
    pub permanent: bool,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "lowercase")]
pub enum Request {
    Ping,
    Submit { user: User, spec: Spec, info: Info },
    List { user: String, since: u64 },
    Control {
        user: String,
        id: u64,
        action: String,
        #[serde(default)]
        policy: Option<Policy>,
        #[serde(default)]
        all: bool,
        #[serde(default)]
        bps: Option<u64>,
        #[serde(default)]
        conflict: Option<u64>,
        #[serde(default)]
        password: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Queued,
    Running,
    Paused,
    Conflict,
    Done,
    Failed,
    Cancelled,
}

impl State {
    fn finished(self) -> bool {
        matches!(self, State::Done | State::Failed | State::Cancelled)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorItem {
    pub path: String,
    pub msg: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct JobView {
    pub id: u64,
    pub op: Op,
    pub info: Info,
    pub state: State,
    pub created: u64,
    pub started: Option<u64>,
    pub finished: Option<u64>,
    /// time spent running, pauses and waits for an answer left out
    pub active_ms: u64,
    pub progress: Progress,
    pub conflict: Option<ConflictInfo>,
    pub errors: Vec<ErrorItem>,
    pub msg: String,
    pub verify: bool,
    pub limit: u64,
    pub policy: Policy,
    /// [ms since start, bytes done, files done, bytes verified]
    pub samples: Vec<[u64; 4]>,
}

struct Job {
    view: JobView,
    owner: String,
    user: User,
    spec: Spec,
    stdin: Option<ChildStdin>,
    run_since: Option<Instant>,
    active: Duration,
    last_sample: Option<Instant>,
    start_instant: Option<Instant>,
    finished_at: Option<Instant>,
    force: bool,
}

impl Job {
    fn set_state(&mut self, state: State) {
        let running = |s: State| s == State::Running;
        if running(self.view.state) && !running(state) {
            if let Some(since) = self.run_since.take() {
                self.active += since.elapsed();
            }
        } else if !running(self.view.state) && running(state) {
            self.run_since = Some(Instant::now());
        }
        self.view.state = state;
        if state.finished() {
            self.finished_at = Some(Instant::now());
            self.view.finished = Some(now_ms());
            self.stdin = None;
        }
    }

    fn active_ms(&self) -> u64 {
        (self.active + self.run_since.map(|s| s.elapsed()).unwrap_or_default()).as_millis() as u64
    }

    fn sample(&mut self, force: bool) {
        let Some(start) = self.start_instant else { return };
        if !force && self.last_sample.is_some_and(|t| t.elapsed() < SAMPLE_EVERY) {
            return;
        }
        self.last_sample = Some(Instant::now());
        let p = &self.view.progress;
        self.view.samples.push([start.elapsed().as_millis() as u64, p.bytes_done, p.files_done, p.verify_bytes]);
        if self.view.samples.len() > MAX_SAMPLES {
            // halve the resolution of the older half, keep the recent one sharp
            let half = self.view.samples.len() / 2;
            let old: Vec<[u64; 4]> = self.view.samples[..half].iter().step_by(2).copied().collect();
            self.view.samples.splice(..half, old);
        }
    }

    fn send(&mut self, cmd: &Command) -> bool {
        let Some(stdin) = self.stdin.as_mut() else { return false };
        let mut line = serde_json::to_vec(cmd).unwrap_or_default();
        line.push(b'\n');
        stdin.write_all(&line).and_then(|()| stdin.flush()).is_ok()
    }
}

type Jobs = Arc<Mutex<VecDeque<Job>>>;

pub fn run() -> std::process::ExitCode {
    let path = socket_path();
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("{}: cannot listen: {e}", path.display());
            return std::process::ExitCode::FAILURE;
        }
    };
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    eprintln!("{} synofile daemon listening on {}", stamp(), path.display());
    let jobs: Jobs = Arc::new(Mutex::new(VecDeque::new()));
    let mut next_id = now_ms();
    for stream in listener.incoming() {
        let Ok(stream) = stream else { continue };
        next_id += 1;
        let jobs = Arc::clone(&jobs);
        let id = next_id;
        std::thread::spawn(move || {
            let _ = serve(stream, &jobs, id);
        });
    }
    std::process::ExitCode::SUCCESS
}

fn serve(stream: UnixStream, jobs: &Jobs, new_id: u64) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10)))?;
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    // the language of the messages: the caller's, until a job says otherwise
    let raw: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
    crate::lang::set(raw.get("lang").and_then(|l| l.as_str()).unwrap_or("it"));
    let answer = match serde_json::from_value::<Request>(raw) {
        Ok(request) => handle(request, jobs, new_id),
        Err(e) => serde_json::json!({ "error": format!("bad request: {e}") }),
    };
    let mut out = &stream;
    serde_json::to_writer(&mut out, &answer)?;
    out.write_all(b"\n")
}

fn handle(request: Request, jobs: &Jobs, new_id: u64) -> serde_json::Value {
    match request {
        Request::Ping => serde_json::json!({ "ok": true, "can_switch_user": crate::caps::effective() || crate::identity::dev() }),
        Request::Submit { user, spec, info } => {
            let view = JobView {
                id: new_id,
                op: spec.op,
                info,
                state: State::Queued,
                created: now_ms(),
                started: None,
                finished: None,
                active_ms: 0,
                progress: Progress::default(),
                conflict: None,
                errors: Vec::new(),
                msg: String::new(),
                verify: spec.verify,
                limit: spec.limit,
                policy: spec.conflict,
                samples: Vec::new(),
            };
            let job = Job {
                view,
                owner: user.name.clone(),
                user,
                spec,
                stdin: None,
                run_since: None,
                active: Duration::ZERO,
                last_sample: None,
                start_instant: None,
                finished_at: None,
                // deletions are quick and should not wait behind a big copy
                force: false,
            };
            let force = job.spec.op == Op::Delete;
            {
                let mut list = jobs.lock().unwrap();
                prune(&mut list);
                list.push_back(Job { force, ..job });
            }
            schedule(jobs);
            serde_json::json!({ "id": new_id })
        }
        Request::List { user, since } => {
            let list = jobs.lock().unwrap();
            let now = now_ms();
            let views: Vec<JobView> = list
                .iter()
                .filter(|j| j.owner.eq_ignore_ascii_case(&user))
                .map(|j| {
                    let mut v = j.view.clone();
                    v.active_ms = j.active_ms();
                    // only the samples taken after the client's previous call
                    let started = v.started.unwrap_or(0);
                    v.samples.retain(|s| started + s[0] > since);
                    v
                })
                .collect();
            serde_json::json!({ "jobs": views, "now": now })
        }
        Request::Control { user, id, action, policy, all, bps, conflict, password } => {
            let mut list = jobs.lock().unwrap();
            let Some(index) = list.iter().position(|j| j.view.id == id && j.owner.eq_ignore_ascii_case(&user)) else {
                return serde_json::json!({ "error": t!("trasferimento inesistente", "no such transfer") });
            };
            let job = &mut list[index];
            let ok = match action.as_str() {
                "pause" if job.view.state == State::Running => {
                    let ok = job.send(&Command::Pause);
                    if ok {
                        job.set_state(State::Paused);
                    }
                    ok
                }
                "resume" if job.view.state == State::Paused => {
                    let ok = job.send(&Command::Resume);
                    if ok {
                        job.set_state(if job.view.conflict.is_some() { State::Conflict } else { State::Running });
                    }
                    ok
                }
                "cancel" if job.view.state == State::Queued => {
                    job.view.msg = t!("annullato", "cancelled").into();
                    job.set_state(State::Cancelled);
                    true
                }
                "cancel" if !job.view.state.finished() => job.send(&Command::Cancel),
                "answer" if job.view.state == State::Conflict || job.view.state == State::Paused => {
                    let Some(waiting) = job.view.conflict.as_ref().map(|c| c.id) else {
                        return serde_json::json!({ "error": t!("nessun conflitto in attesa", "no conflict waiting") });
                    };
                    if conflict.is_some_and(|c| c != waiting) {
                        return serde_json::json!({ "error": t!("conflitto già risolto", "conflict already settled") });
                    }
                    let conflict = waiting;
                    let ok = job.send(&Command::Answer { id: conflict, action: policy.unwrap_or(Policy::Skip), all });
                    if ok {
                        job.view.conflict = None;
                        if all {
                            job.view.policy = policy.unwrap_or(Policy::Skip);
                        }
                        if job.view.state == State::Conflict {
                            job.set_state(State::Running);
                        }
                    }
                    ok
                }
                "limit" => {
                    let bps = bps.unwrap_or(0);
                    job.view.limit = bps;
                    job.spec.limit = bps;
                    job.view.state == State::Queued || job.send(&Command::Limit { bps })
                }
                "start" if job.view.state == State::Queued => {
                    job.force = true;
                    drop(list);
                    schedule(jobs);
                    return serde_json::json!({ "ok": true });
                }
                "retry" if job.view.state.finished() => {
                    // the same job again, with the archive's password
                    let mut spec = job.spec.clone();
                    if password.is_some() {
                        spec.password = password;
                    }
                    let (user, info) = (job.user.clone(), job.view.info.clone());
                    list.remove(index);
                    drop(list);
                    return handle(Request::Submit { user, spec, info }, jobs, new_id);
                }
                "dismiss" if job.view.state.finished() => {
                    list.remove(index);
                    true
                }
                _ => false,
            };
            serde_json::json!({ "ok": ok })
        }
    }
}

fn prune(list: &mut VecDeque<Job>) {
    list.retain(|j| j.finished_at.is_none_or(|t| t.elapsed() < KEEP_FINISHED));
    while list.len() >= MAX_JOBS {
        match list.iter().position(|j| j.view.state.finished()) {
            Some(i) => {
                list.remove(i);
            }
            None => break,
        }
    }
}

/// Starts queued jobs while there is room, and forced ones at once.
fn schedule(jobs: &Jobs) {
    let mut list = jobs.lock().unwrap();
    let mut running = list.iter().filter(|j| !j.view.state.finished() && j.view.state != State::Queued).count();
    let ids: Vec<u64> = list.iter().filter(|j| j.view.state == State::Queued).map(|j| j.view.id).collect();
    for id in ids {
        let job = list.iter_mut().find(|j| j.view.id == id).unwrap();
        if running >= MAX_PARALLEL && !job.force {
            continue;
        }
        running += 1;
        match spawn(job) {
            Ok(stdout) => {
                let jobs = Arc::clone(jobs);
                std::thread::spawn(move || follow(&jobs, id, stdout));
            }
            Err(e) => {
                job.view.msg = t!("impossibile avviare la copia: {}", "the copy cannot start: {}", e);
                job.set_state(State::Failed);
                running -= 1;
            }
        }
    }
}

fn worker_command() -> io::Result<std::process::Command> {
    let exe = std::env::current_exe()?;
    let worker = exe.with_file_name("synofile-worker");
    if worker.exists() {
        return Ok(std::process::Command::new(worker));
    }
    if crate::identity::dev() {
        let mut cmd = std::process::Command::new(exe);
        cmd.arg("worker");
        return Ok(cmd);
    }
    Err(io::Error::other(format!("{} is missing", worker.display())))
}

fn spawn(job: &mut Job) -> io::Result<std::process::ChildStdout> {
    if !crate::caps::effective() && !crate::identity::dev() {
        return Err(io::Error::other(t!("permessi del pacchetto da attivare: sudo /var/packages/synofile/target/bin/synofile setup", "the package permissions need enabling: sudo /var/packages/synofile/target/bin/synofile setup")));
    }
    let mut cmd = worker_command()?;
    cmd.env_clear().env("PATH", "/usr/bin:/bin").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    let user = job.user.clone();
    if crate::identity::dev() {
        cmd.env("SYNOFILE_DEV_USER", &user.name);
    } else {
        let groups = user.groups.clone();
        let (uid, gid) = (user.uid, user.gid);
        // SAFETY: only system calls between fork and exec
        unsafe {
            cmd.pre_exec(move || crate::identity::become_raw(uid, gid, &groups));
        }
    }
    let mut child = cmd.spawn()?;
    let mut stdin = child.stdin.take().ok_or_else(|| io::Error::other("no stdin"))?;
    let stdout = child.stdout.take().ok_or_else(|| io::Error::other("no stdout"))?;
    let mut line = serde_json::to_vec(&job.spec).map_err(io::Error::other)?;
    line.push(b'\n');
    stdin.write_all(&line)?;
    job.stdin = Some(stdin);
    job.view.started = Some(now_ms());
    job.start_instant = Some(Instant::now());
    job.set_state(State::Running);
    job.sample(true);
    // reap the child when it ends, whatever happened
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(stdout)
}

fn follow(jobs: &Jobs, id: u64, stdout: std::process::ChildStdout) {
    let lang = jobs.lock().unwrap().iter().find(|j| j.view.id == id).map(|j| j.spec.lang.clone()).unwrap_or_default();
    crate::lang::set(&lang);
    let mut done = false;
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Ok(event) = serde_json::from_str::<Event>(&line) else { continue };
        let mut list = jobs.lock().unwrap();
        let Some(job) = list.iter_mut().find(|j| j.view.id == id) else { return };
        match event {
            Event::Progress(p) => {
                job.view.progress = p;
                job.sample(false);
            }
            Event::Conflict(c) => {
                job.view.conflict = Some(c);
                if job.view.state == State::Running {
                    job.set_state(State::Conflict);
                }
            }
            Event::Error { path, msg } => {
                if job.view.errors.len() < MAX_ERRORS {
                    job.view.errors.push(ErrorItem { path, msg });
                }
            }
            Event::Done { status, msg } => {
                job.sample(true);
                job.view.msg = msg;
                job.view.conflict = None;
                job.set_state(match status {
                    Status::Ok => State::Done,
                    Status::Cancelled => State::Cancelled,
                    Status::Failed => State::Failed,
                });
                done = true;
            }
        }
    }
    if !done {
        let mut list = jobs.lock().unwrap();
        if let Some(job) = list.iter_mut().find(|j| j.view.id == id) {
            job.sample(true);
            job.view.msg = t!("il processo di copia si è interrotto inaspettatamente", "the copy process stopped unexpectedly").into();
            job.set_state(State::Failed);
        }
    }
    schedule(jobs);
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn stamp() -> String {
    let s = now_ms() / 1000;
    format!("[{}]", s)
}

/// The CGI side: one request, one answer.
pub fn call(request: &serde_json::Value) -> io::Result<serde_json::Value> {
    let stream = UnixStream::connect(socket_path())?;
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    let mut out = &stream;
    serde_json::to_writer(&mut out, request)?;
    out.write_all(b"\n")?;
    let mut line = String::new();
    BufReader::new(&stream).read_line(&mut line)?;
    serde_json::from_str(&line).map_err(io::Error::other)
}
