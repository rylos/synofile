//! The list of a server's shares: NetrShareEnum (level 1) over the
//! \pipe\srvsvc named pipe, in DCE/RPC with NDR32.
//!
//! The smb crate has its own, which binds NDR64 only (Samba refuses it)
//! and reads a single fragment (Windows answers a long list in several):
//! this one is written by hand, after [MS-SRVS] 3.1.4.8 and [C706].

const SRVSVC: ([u8; 16], u16) = (uuid(0x4b324fc8, 0x1670, 0x01d3, [0x12, 0x78, 0x5a, 0x47, 0xbf, 0x6e, 0xe1, 0x88]), 3);
const NDR: ([u8; 16], u16) = (uuid(0x8a885d04, 0x1ceb, 0x11c9, [0x9f, 0xe8, 0x08, 0x00, 0x2b, 0x10, 0x48, 0x60]), 2);

const fn uuid(a: u32, b: u16, c: u16, d: [u8; 8]) -> [u8; 16] {
    let a = a.to_le_bytes();
    let b = b.to_le_bytes();
    let c = c.to_le_bytes();
    [a[0], a[1], a[2], a[3], b[0], b[1], c[0], c[1], d[0], d[1], d[2], d[3], d[4], d[5], d[6], d[7]]
}

fn pdu(ptype: u8, call: u32, body: &[u8]) -> Vec<u8> {
    let mut p = vec![5, 0, ptype, 0x03, 0x10, 0, 0, 0];
    p.extend(((16 + body.len()) as u16).to_le_bytes());
    p.extend(0u16.to_le_bytes());
    p.extend(call.to_le_bytes());
    p.extend(body);
    p
}

pub fn bind() -> Vec<u8> {
    let mut b = Vec::new();
    b.extend(4280u16.to_le_bytes());
    b.extend(4280u16.to_le_bytes());
    b.extend(0u32.to_le_bytes());
    b.extend([1, 0, 0, 0]);
    b.extend(0u16.to_le_bytes());
    b.extend([1, 0]);
    b.extend(SRVSVC.0);
    b.extend(SRVSVC.1.to_le_bytes());
    b.extend(0u16.to_le_bytes());
    b.extend(NDR.0);
    b.extend((NDR.1 as u32).to_le_bytes());
    pdu(11, 1, &b)
}

fn put_string(b: &mut Vec<u8>, s: &str) {
    let w: Vec<u16> = s.encode_utf16().chain([0]).collect();
    b.extend((w.len() as u32).to_le_bytes());
    b.extend(0u32.to_le_bytes());
    b.extend((w.len() as u32).to_le_bytes());
    for c in w {
        b.extend(c.to_le_bytes());
    }
    while b.len() % 4 != 0 {
        b.push(0);
    }
}

pub fn share_enum(server: &str) -> Vec<u8> {
    let mut s = Vec::new();
    s.extend(0x20000u32.to_le_bytes()); // ServerName referent
    put_string(&mut s, &format!("\\\\{server}"));
    s.extend(1u32.to_le_bytes()); // Level
    s.extend(1u32.to_le_bytes()); // union switch
    s.extend(0x20004u32.to_le_bytes()); // Level1 container referent
    s.extend(0u32.to_le_bytes()); // EntriesRead
    s.extend(0u32.to_le_bytes()); // Buffer: null
    s.extend(u32::MAX.to_le_bytes()); // PreferedMaximumLength
    s.extend(0u32.to_le_bytes()); // ResumeHandle: null
    let mut b = Vec::new();
    b.extend((s.len() as u32).to_le_bytes());
    b.extend(0u16.to_le_bytes()); // context
    b.extend(15u16.to_le_bytes()); // opnum NetrShareEnum
    b.extend(s);
    pdu(0, 2, &b)
}

/// The stub data of the fragments in `resp`, joined.
pub fn stub(resp: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    let mut at = 0;
    while at + 24 <= resp.len() {
        let ptype = resp[at + 2];
        let flen = u16::from_le_bytes([resp[at + 8], resp[at + 9]]) as usize;
        if ptype == 3 {
            return Err(format!("rpc fault 0x{:08x}", u32::from_le_bytes(resp[at + 24..at + 28].try_into().unwrap())));
        }
        if ptype == 13 {
            return Err("bind refused".into());
        }
        let end = (at + flen).min(resp.len());
        if ptype == 2 {
            out.extend(&resp[at + 24..end]);
        }
        let last = resp[at + 3] & 2 != 0;
        at += flen;
        if last {
            break;
        }
    }
    Ok(out)
}

struct R<'a>(&'a [u8], usize);
impl R<'_> {
    fn u32(&mut self) -> Result<u32, String> {
        let v = self.0.get(self.1..self.1 + 4).ok_or("short")?;
        self.1 += 4;
        Ok(u32::from_le_bytes(v.try_into().unwrap()))
    }
    fn string(&mut self) -> Result<String, String> {
        self.u32()?;
        self.u32()?;
        let n = self.u32()? as usize;
        let raw = self.0.get(self.1..self.1 + 2 * n).ok_or("short")?;
        self.1 += 2 * n;
        self.1 = (self.1 + 3) & !3;
        let w: Vec<u16> = raw.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|&c| c != 0).collect();
        Ok(String::from_utf16_lossy(&w))
    }
}

/// (name, type, remark)
pub fn parse(stub: &[u8]) -> Result<Vec<(String, u32, String)>, String> {
    let mut r = R(stub, 0);
    r.u32()?; // level
    r.u32()?; // switch
    if r.u32()? == 0 {
        return Ok(vec![]);
    }
    let n = r.u32()? as usize;
    if r.u32()? == 0 {
        return Ok(vec![]);
    }
    r.u32()?; // max count
    let mut heads = Vec::with_capacity(n);
    for _ in 0..n {
        heads.push((r.u32()?, r.u32()?, r.u32()?));
    }
    let mut out = Vec::with_capacity(n);
    for (np, t, rp) in heads {
        let name = if np != 0 { r.string()? } else { String::new() };
        let remark = if rp != 0 { r.string()? } else { String::new() };
        out.push((name, t, remark));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_share_list() {
        // a response stub with two shares, the second without a remark
        let mut s = Vec::new();
        for v in [1u32, 1, 0x20000, 2, 0x20004, 2, 0x20008, 0, 0x2000c, 0x20010, 0x80000003, 0] {
            s.extend(v.to_le_bytes());
        }
        put_string(&mut s, "Public");
        put_string(&mut s, "all of us");
        put_string(&mut s, "IPC$");
        let shares = parse(&s).unwrap();
        assert_eq!(shares, vec![("Public".into(), 0, "all of us".into()), ("IPC$".into(), 0x80000003, String::new())]);
        // the stub of two fragments, joined
        let mut first = pdu(2, 2, &[0; 8]);
        first[3] = 1; // first fragment only
        first.extend(b"abcd");
        first[8] = first.len() as u8;
        let mut last = pdu(2, 2, &[0; 8]);
        last[3] = 2;
        last.extend(b"efgh");
        last[8] = last.len() as u8;
        assert_eq!(stub(&[first, last].concat()).unwrap(), b"abcdefgh");
    }
}
