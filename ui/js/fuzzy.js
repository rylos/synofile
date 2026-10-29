// fzf-style matching: every letter of the query, in order, anywhere in the
// name. Words of the query must all match. Matches at the start of a word,
// and letters in a row, score higher. The same rules as src/fsops.rs.

const BOUNDARY = /[\s_\-.()\[\]]/;

function scoreTerm(term, name, lower) {
  // greedy forward pass, then a backward pass to tighten the match (fzf v1)
  let ti = 0;
  let end = -1;
  for (let i = 0; i < lower.length && ti < term.length; i++) {
    if (lower[i] === term[ti]) {
      ti++;
      if (ti === term.length) end = i;
    }
  }
  if (end < 0) return null;
  ti = term.length - 1;
  let start = end;
  for (let i = end; i >= 0 && ti >= 0; i--) {
    if (lower[i] === term[ti]) {
      ti--;
      start = i;
    }
  }
  const positions = [];
  let score = 0;
  let run = 0;
  ti = 0;
  for (let i = start; i <= end && ti < term.length; i++) {
    if (lower[i] !== term[ti]) {
      run = 0;
      score -= 1;
      continue;
    }
    positions.push(i);
    let s = 10;
    if (i === 0) s += 18;
    else if (BOUNDARY.test(name[i - 1])) s += 14;
    else if (name[i] !== lower[i] && name[i - 1] === lower[i - 1]) s += 10; // camelCase hump
    run++;
    if (run > 1) s += 6 * Math.min(run, 6);
    if (name[i] === term[ti]) s += 1;
    score += s;
    ti++;
  }
  // shorter names, and matches early in the name, rank first
  score -= Math.min(20, start) * 0.5 + name.length * 0.05;
  return { score, positions };
}

/** null when the name does not match, else {score, positions}. */
export function fuzzy(query, name) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return null;
  const lower = name.toLowerCase();
  let score = 0;
  const positions = new Set();
  for (const term of terms) {
    const m = scoreTerm(term, name, lower);
    if (!m) return null;
    score += m.score;
    m.positions.forEach((p) => positions.add(p));
  }
  return { score, positions: [...positions].sort((a, b) => a - b) };
}

/** The name as HTML with the matched letters marked. */
export function highlight(name, positions, esc) {
  if (!positions || !positions.length) return esc(name);
  let out = "";
  const set = new Set(positions);
  let open = false;
  for (let i = 0; i < name.length; i++) {
    const hit = set.has(i);
    if (hit && !open) {
      out += "<mark>";
      open = true;
    } else if (!hit && open) {
      out += "</mark>";
      open = false;
    }
    out += esc(name[i]);
  }
  return out + (open ? "</mark>" : "");
}
