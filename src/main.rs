//! synofile: a file manager for the shared folders of a Synology NAS.
//!
//! One binary, several faces: run by DSM's web server it is the CGI behind
//! the interface; `daemon` keeps the transfers; installed again as
//! `synofile-worker` (no capabilities, started already as the user) it
//! copies, moves and deletes.

#[macro_use]
mod lang;
mod api;
mod archive;
mod auth;
mod caps;
mod cgi;
mod edit;
mod fsops;
mod identity;
mod jobs;
mod remote;
mod shares;
mod space;
mod transfer;
mod zip;

use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage: synofile setup | daemon | version
  setup     give this binary the capabilities it needs (as root, once
            after every install or upgrade of the package)
  daemon    the transfer service, started by the package
Run by DSM's web server (GATEWAY_INTERFACE set) it answers the API.";

/// The package's own writable directory.
pub fn var_dir() -> PathBuf {
    std::env::var_os("SYNOPKG_PKGVAR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("/var/packages/synofile/var"))
}

fn main() -> ExitCode {
    let argv0 = std::env::args().next().unwrap_or_default();
    if argv0.rsplit('/').next() == Some("synofile-worker") {
        return jobs::worker::run();
    }
    if std::env::var_os("GATEWAY_INTERFACE").is_some() {
        return match api::serve() {
            Ok(()) => ExitCode::SUCCESS,
            Err(_) => ExitCode::FAILURE,
        };
    }
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.iter().map(String::as_str).collect::<Vec<_>>().as_slice() {
        ["setup"] => setup(),
        ["daemon"] => jobs::daemon::run(),
        // development builds start the worker through the main binary
        ["worker"] if identity::dev() => jobs::worker::run(),
        #[cfg(debug_assertions)]
        ["remote", rest @ ..] => remote::probe(rest),
        ["version"] => {
            println!("synofile {}", api::VERSION);
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("{USAGE}");
            ExitCode::from(2)
        }
    }
}

fn setup() -> ExitCode {
    let binary = match std::env::current_exe() {
        Ok(path) => path,
        Err(e) => {
            eprintln!("cannot locate this binary: {e}");
            return ExitCode::FAILURE;
        }
    };
    match caps::install(&binary) {
        Ok(()) => {
            println!("{}: cap_setuid and cap_setgid set", binary.display());
            println!("restart the package so the transfer service picks them up");
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("{}: {e} (run it as root: sudo {} setup)", binary.display(), binary.display());
            ExitCode::FAILURE
        }
    }
}
