/*
 * synofile-helper.c
 *
 * Narrow setuid-root helper for SynoFile. It does what `synofile setup`
 * does (src/caps.rs, install()), but without ever executing a file the
 * package user can write.
 *
 * Declared in conf/privilege as bin/helper/synofile-helper, root:<package
 * group>, setuid. 4550 is enough (no setgid needed). The helper takes no
 * arguments and reads no environment.
 *
 * What it does, in this order:
 *   1. Resolves /var/packages/synofile/target (a symlink) once and works
 *      only from that directory with openat() and O_NOFOLLOW, so nothing
 *      below it can be redirected with a symlink.
 *   2. target/, target/bin/ and target/bin/helper/ become root:<group> 0755,
 *      so the package user can no longer rename anything over the files
 *      inside them. <group> is the group of this helper file (root-owned,
 *      so the package user cannot change it), never root:root.
 *   3. bin/synofile and bin/synofile-worker are COPIED to new files created
 *      by root, hashing the bytes while they are copied. If the SHA-256 is
 *      not the one compiled into this helper, nothing is installed. Because
 *      the bytes that were hashed are the bytes that were written, a
 *      process that kept an old write handle to the original cannot change
 *      them afterwards.
 *   4. The copy of bin/synofile gets root:<group> 0750 and the file
 *      capabilities (cap_dac_override, cap_dac_read_search, cap_fowner,
 *      cap_setuid, cap_setgid +ep: the
 *      same 20 bytes as xattr_value() in caps.rs). The copy of
 *      bin/synofile-worker gets root:<group> 0755 and no capabilities.
 *      Each copy is renamed over the original; renaming over a running
 *      binary is fine.
 *
 * Build (static, x86_64; the hash is of the release binary build.sh makes):
 *   cc -O2 -static -Wall -Wextra -DEXPECTED_SHA256='"<64 hex digits>"' \
 *      -o synofile-helper synofile-helper.c
 *
 * bin/synofile and bin/synofile-worker must be the same file: build.sh
 * copies one binary to both names. If they ever differ, this needs a
 * second hash.
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/xattr.h>
#include <unistd.h>

#ifndef TARGET_LINK
#define TARGET_LINK "/var/packages/synofile/target"
#endif
#ifndef PKG_DIRNAME
#define PKG_DIRNAME "synofile"
#endif
#ifndef SELF_EXE
#define SELF_EXE "/proc/self/exe"
#endif
#ifndef EXPECTED_SHA256
#error "build with -DEXPECTED_SHA256='\"<sha256 of the synofile binary>\"'"
#endif

#define TMP_NAME ".synofile-helper.tmp"

/* cap_dac_override,cap_dac_read_search,cap_fowner,cap_setuid,cap_setgid +ep, revision 2 (caps.rs) */
static const unsigned char CAPS[20] = {
    0x01, 0, 0, 0x02, 0xce, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
};

static int fail(const char *what)
{
    fprintf(stderr, "synofile-helper: %s: %s\n", what, strerror(errno));
    return -1;
}

/* ---- SHA-256 (FIPS 180-4) ------------------------------------------- */

struct sha256 {
    uint32_t h[8];
    uint8_t buf[64];
    uint64_t len;
    size_t n;
};

static const uint32_t K[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
};

#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

static void sha256_block(struct sha256 *s, const uint8_t *p)
{
    uint32_t w[64], a, b, c, d, e, f, g, h;
    for (int i = 0; i < 16; i++)
        w[i] = (uint32_t)p[4 * i] << 24 | (uint32_t)p[4 * i + 1] << 16 |
               (uint32_t)p[4 * i + 2] << 8 | (uint32_t)p[4 * i + 3];
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    a = s->h[0]; b = s->h[1]; c = s->h[2]; d = s->h[3];
    e = s->h[4]; f = s->h[5]; g = s->h[6]; h = s->h[7];
    for (int i = 0; i < 64; i++) {
        uint32_t S1 = ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25);
        uint32_t ch = (e & f) ^ (~e & g);
        uint32_t t1 = h + S1 + ch + K[i] + w[i];
        uint32_t S0 = ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22);
        uint32_t mj = (a & b) ^ (a & c) ^ (b & c);
        uint32_t t2 = S0 + mj;
        h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    s->h[0] += a; s->h[1] += b; s->h[2] += c; s->h[3] += d;
    s->h[4] += e; s->h[5] += f; s->h[6] += g; s->h[7] += h;
}

static void sha256_init(struct sha256 *s)
{
    static const uint32_t iv[8] = {
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    };
    memcpy(s->h, iv, sizeof iv);
    s->len = 0;
    s->n = 0;
}

static void sha256_update(struct sha256 *s, const uint8_t *p, size_t len)
{
    s->len += len;
    while (len > 0) {
        size_t take = 64 - s->n;
        if (take > len)
            take = len;
        memcpy(s->buf + s->n, p, take);
        s->n += take;
        p += take;
        len -= take;
        if (s->n == 64) {
            sha256_block(s, s->buf);
            s->n = 0;
        }
    }
}

static void sha256_hex(struct sha256 *s, char out[65])
{
    uint64_t bits = s->len * 8;
    uint8_t pad = 0x80;
    uint8_t zero = 0;
    uint8_t lenbuf[8];
    sha256_update(s, &pad, 1);
    while (s->n != 56)
        sha256_update(s, &zero, 1);
    for (int i = 0; i < 8; i++)
        lenbuf[i] = (uint8_t)(bits >> (56 - 8 * i));
    sha256_update(s, lenbuf, 8);
    for (int i = 0; i < 8; i++)
        snprintf(out + 8 * i, 9, "%08x", s->h[i]);
}

/* ---- file operations ------------------------------------------------- */

static int write_all(int fd, const uint8_t *p, size_t len)
{
    while (len > 0) {
        ssize_t n = write(fd, p, len);
        if (n < 0) {
            if (errno == EINTR)
                continue;
            return -1;
        }
        p += n;
        len -= (size_t)n;
    }
    return 0;
}

/* root:<gid> 0755 on a directory we hold open */
static int harden_dir(int fd, gid_t gid, const char *name)
{
    if (fchown(fd, 0, gid) < 0 || fchmod(fd, 0755) < 0)
        return fail(name);
    return 0;
}

/*
 * Copies dir/name to a new root-owned file, checking the SHA-256 of the
 * bytes as they are written, then gives it owner, mode and (optionally) the
 * file capabilities, and renames it over the original.
 */
static int install_copy(int dirfd, const char *name, gid_t gid, mode_t mode, int with_caps)
{
    uint8_t buf[65536];
    struct sha256 sha;
    char hex[65];
    struct stat st;
    int src = -1, dst = -1, rc = -1;

    /* O_NONBLOCK: a FIFO put in its place must not hang this process, which
     * nobody but root can then kill (and with it the package install) */
    src = openat(dirfd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (src < 0 || fstat(src, &st) < 0) {
        fail(name);
        goto out;
    }
    if (!S_ISREG(st.st_mode)) {
        fprintf(stderr, "synofile-helper: %s is not a regular file\n", name);
        goto out;
    }
    if (fcntl(src, F_SETFL, 0) < 0) {
        fail(name);
        goto out;
    }
    if (unlinkat(dirfd, TMP_NAME, 0) < 0 && errno != ENOENT) {
        fail("remove old temporary file");
        goto out;
    }
    dst = openat(dirfd, TMP_NAME, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0700);
    if (dst < 0) {
        fail("create temporary file");
        goto out;
    }

    sha256_init(&sha);
    for (;;) {
        ssize_t n = read(src, buf, sizeof buf);
        if (n < 0) {
            if (errno == EINTR)
                continue;
            fail(name);
            goto out_unlink;
        }
        if (n == 0)
            break;
        sha256_update(&sha, buf, (size_t)n);
        if (write_all(dst, buf, (size_t)n) < 0) {
            fail("write temporary file");
            goto out_unlink;
        }
    }
    sha256_hex(&sha, hex);
    if (strcmp(hex, EXPECTED_SHA256) != 0) {
        fprintf(stderr, "synofile-helper: %s does not match the build this helper belongs to\n"
                        "  expected %s\n  found    %s\n", name, EXPECTED_SHA256, hex);
        goto out_unlink;
    }

    /* chown first: it would drop the capability */
    if (fchown(dst, 0, gid) < 0 || fchmod(dst, mode) < 0) {
        fail("chown/chmod");
        goto out_unlink;
    }
    if (with_caps && fsetxattr(dst, "security.capability", CAPS, sizeof CAPS, 0) < 0) {
        fail("set file capabilities");
        goto out_unlink;
    }
    if (fsync(dst) < 0) {
        fail("fsync");
        goto out_unlink;
    }
    if (renameat(dirfd, TMP_NAME, dirfd, name) < 0) {
        fail("rename into place");
        goto out_unlink;
    }
    rc = 0;
    goto out;

out_unlink:
    unlinkat(dirfd, TMP_NAME, 0);
out:
    if (src >= 0)
        close(src);
    if (dst >= 0)
        close(dst);
    return rc;
}

int main(int argc, char *argv[])
{
    char resolved[PATH_MAX];
    struct stat self;
    const char *base;
    int tfd = -1, bfd = -1, hfd = -1;
    gid_t gid;

    (void)argv;
    if (argc != 1) {
        fprintf(stderr, "synofile-helper: takes no arguments\n");
        return 1;
    }
    if (geteuid() != 0) {
        fprintf(stderr, "synofile-helper: not running as root (is it setuid?)\n");
        return 1;
    }
    /* real, effective and saved ids all root: the caller's own user can then
     * no longer signal this process */
    if (setresuid(0, 0, 0) < 0) {
        fail("setresuid");
        return 1;
    }
    umask(022);
    if (clearenv() != 0) {
        fprintf(stderr, "synofile-helper: clearenv failed\n");
        return 1;
    }

    /* the group is this helper's own: a root-owned file the package user
     * cannot change */
    if (stat(SELF_EXE, &self) < 0) {
        fail("stat self");
        return 1;
    }
    if (self.st_uid != 0 || self.st_gid == 0) {
        fprintf(stderr, "synofile-helper: must be owned root:<package group>\n");
        return 1;
    }
    gid = self.st_gid;

    /* target is a symlink to /volumeN/@appstore/synofile; resolve it once */
    if (!realpath(TARGET_LINK, resolved)) {
        fail(TARGET_LINK);
        return 1;
    }
    base = strrchr(resolved, '/');
    base = base ? base + 1 : resolved;
    if (strcmp(base, PKG_DIRNAME) != 0) {
        fprintf(stderr, "synofile-helper: %s resolves to %s, not a %s directory\n",
                TARGET_LINK, resolved, PKG_DIRNAME);
        return 1;
    }

    /* top down: each directory becomes root's before anything under it is
     * trusted, and everything below is reached with openat + O_NOFOLLOW */
    tfd = open(resolved, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (tfd < 0 || harden_dir(tfd, gid, "package directory") < 0) {
        if (tfd < 0)
            fail(resolved);
        return 1;
    }
    bfd = openat(tfd, "bin", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (bfd < 0 || harden_dir(bfd, gid, "bin directory") < 0) {
        if (bfd < 0)
            fail("bin directory");
        return 1;
    }
    hfd = openat(bfd, "helper", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (hfd >= 0) {
        if (harden_dir(hfd, gid, "helper directory") < 0)
            return 1;
        close(hfd);
    } else if (errno != ENOENT) {
        fail("helper directory");
        return 1;
    }

    if (install_copy(bfd, "synofile-worker", gid, 0755, 0) < 0 ||
        install_copy(bfd, "synofile", gid, 0750, 1) < 0)
        return 1;

    printf("synofile-helper: cap_setuid, cap_setgid, cap_dac_override, cap_dac_read_search and cap_fowner set on %s/bin/synofile\n",
           resolved);
    return 0;
}
