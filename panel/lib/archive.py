#!/usr/bin/env python3
"""Zip and unzip for Station 256, using only Python's own tools.

  archive.py compress <new.zip> <path>...        one zip holding those files and folders
  archive.py extract <archive> <folder> <mode>   mode "all": into one new folder named after it
                                                 mode "here": loose in <folder> if it holds one thing
  archive.py list <archive>                      what's inside, as JSON

Progress goes to stdout as JSON lines: {"done": n, "total": n, "names": [...]}. The last line is
{"result": ...}. Nothing is ever written outside the folder it was asked to write in: names that
try to climb out ("../", absolute paths, links pointing out) are refused.
"""
import json
import os
import shutil
import sys
import tarfile
import time
import zipfile

TAR_ENDINGS = ('.tar', '.tar.gz', '.tgz', '.tar.xz', '.txz', '.tar.bz2', '.tbz2', '.tbz')
last_said = 0.0


def say(**fields):
    print(json.dumps(fields), flush=True)


def progress(done, total, names=None, final=False):
    global last_said
    now = time.monotonic()
    if final or now - last_said > 0.1:
        last_said = now
        say(done=done, total=total, names=names, final=final)


def free_name(folder, name):
    """name, or "name (2)", "name (3)"... whichever isn't taken."""
    if not os.path.lexists(os.path.join(folder, name)):
        return name
    stem, dot, ext = name.rpartition('.')
    if not stem:  # no dot, or a name like ".env"
        stem, dot, ext = name, '', ''
    if name.lower().endswith(TAR_ENDINGS):
        for ending in TAR_ENDINGS:
            if name.lower().endswith(ending):
                stem, dot, ext = name[: -len(ending)], '.', ending[1:]
                break
    n = 2
    while True:
        candidate = f"{stem} ({n}){dot}{ext}"
        if not os.path.lexists(os.path.join(folder, candidate)):
            return candidate
        n += 1


def base_name(archive):
    name = os.path.basename(archive)
    lower = name.lower()
    for ending in TAR_ENDINGS + ('.zip', '.gz', '.xz', '.bz2'):
        if lower.endswith(ending):
            return name[: -len(ending)] or 'Extracted'
    return os.path.splitext(name)[0] or 'Extracted'


def compress(target, paths):
    paths = [os.path.abspath(p) for p in paths]
    files = []
    for p in paths:
        top = os.path.dirname(p)
        if os.path.isdir(p) and not os.path.islink(p):
            files.append((p, os.path.relpath(p, top) + '/', 0))
            for root, dirs, names in os.walk(p):
                dirs.sort()
                for d in dirs:
                    full = os.path.join(root, d)
                    if os.path.islink(full):
                        continue
                    files.append((full, os.path.relpath(full, top) + '/', 0))
                for n in sorted(names):
                    full = os.path.join(root, n)
                    if os.path.isfile(full) and not os.path.islink(full):
                        files.append((full, os.path.relpath(full, top), os.path.getsize(full)))
        elif os.path.isfile(p):
            files.append((p, os.path.basename(p), os.path.getsize(p)))
    total = sum(size for _, _, size in files) or 1
    done = 0
    folder = os.path.dirname(target)
    partial = os.path.join(folder, f".{os.path.basename(target)}.part")
    names = [os.path.basename(target)]
    try:
        with zipfile.ZipFile(partial, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
            for full, arc, size in files:
                if arc.endswith('/'):
                    zf.write(full, arc)
                    continue
                info = zipfile.ZipInfo.from_file(full, arc)
                info.compress_type = zipfile.ZIP_DEFLATED
                with open(full, 'rb') as src, zf.open(info, 'w', force_zip64=True) as dst:
                    while True:
                        chunk = src.read(1 << 20)
                        if not chunk:
                            break
                        dst.write(chunk)
                        done += len(chunk)
                        progress(done, total, names)
        os.replace(partial, target)
    finally:
        if os.path.exists(partial):
            os.remove(partial)
    progress(total, total, names, final=True)
    say(result={'made': target})


def safe_members_zip(zf, dest):
    real_dest = os.path.realpath(dest)
    for info in zf.infolist():
        name = info.filename.replace('\\', '/')
        parts = [p for p in name.split('/') if p not in ('', '.')]
        if not parts or '..' in parts or name.startswith('/') or ':' in parts[0]:
            raise ValueError(f'"{info.filename}" would land outside the folder, so nothing was unpacked.')
        # Links inside a zip are stored as files with a special mode. They're unpacked as plain files.
        out = os.path.realpath(os.path.join(dest, *parts))
        if not (out == real_dest or out.startswith(real_dest + os.sep)):
            raise ValueError(f'"{info.filename}" would land outside the folder, so nothing was unpacked.')
        yield info, parts


def extract_into(archive, dest):
    lower = archive.lower()
    names = [os.path.basename(archive)]
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as zf:
            members = list(safe_members_zip(zf, dest))
            total = sum(info.file_size for info, _ in members) or 1
            done = 0
            for info, parts in members:
                out = os.path.join(dest, *parts)
                if info.is_dir():
                    os.makedirs(out, exist_ok=True)
                    continue
                os.makedirs(os.path.dirname(out), exist_ok=True)
                with zf.open(info) as src, open(out, 'wb') as dst:
                    while True:
                        chunk = src.read(1 << 20)
                        if not chunk:
                            break
                        dst.write(chunk)
                        done += len(chunk)
                        progress(done, total, names)
                mode = (info.external_attr >> 16) & 0o777
                if mode & 0o100:
                    os.chmod(out, 0o755)
        return
    if lower.endswith(TAR_ENDINGS) or tarfile.is_tarfile(archive):
        with tarfile.open(archive) as tf:
            members = tf.getmembers()
            total = sum(m.size for m in members) or 1
            done = 0
            for m in members:
                # The "data" filter refuses anything that climbs out, absolute paths, devices and outward links.
                tf.extract(m, dest, filter='data')
                done += m.size
                progress(done, total, names)
        return
    for ending, opener in (('.gz', 'gzip'), ('.xz', 'lzma'), ('.bz2', 'bz2')):
        if lower.endswith(ending):
            module = __import__(opener)
            out = os.path.join(dest, base_name(archive))
            total = os.path.getsize(archive) or 1
            with module.open(archive, 'rb') as src, open(out, 'wb') as dst:
                shutil.copyfileobj(src, dst, 1 << 20)
            progress(total, total, names)
            return
    raise ValueError('This kind of archive can\'t be opened here yet. Zip, tar, gz, xz and bz2 work.')


def extract(archive, folder, mode):
    archive = os.path.abspath(archive)
    folder = os.path.abspath(folder)
    work = os.path.join(folder, f".unpacking-{os.getpid()}")
    os.makedirs(work)
    try:
        extract_into(archive, work)
        inside = sorted(os.listdir(work))
        made = []
        if mode == 'here' and len(inside) == 1:
            name = free_name(folder, inside[0])
            os.rename(os.path.join(work, inside[0]), os.path.join(folder, name))
            made.append(os.path.join(folder, name))
        else:
            name = free_name(folder, base_name(archive))
            os.rename(work, os.path.join(folder, name))
            made.append(os.path.join(folder, name))
    finally:
        if os.path.isdir(work):
            shutil.rmtree(work, ignore_errors=True)
    progress(1, 1, [os.path.basename(archive)], final=True)
    say(result={'made': made})


def listing(archive):
    entries = []
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as zf:
            for info in zf.infolist()[:2000]:
                entries.append({'name': info.filename, 'size': info.file_size, 'packed': info.compress_size, 'dir': info.is_dir()})
            count = len(zf.infolist())
    elif tarfile.is_tarfile(archive):
        with tarfile.open(archive) as tf:
            members = tf.getmembers()
            count = len(members)
            for m in members[:2000]:
                entries.append({'name': m.name + ('/' if m.isdir() else ''), 'size': m.size, 'packed': None, 'dir': m.isdir()})
    else:
        raise ValueError('This kind of archive can\'t be opened here yet. Zip, tar, gz, xz and bz2 work.')
    say(result={'entries': entries, 'count': count})


def main():
    try:
        command = sys.argv[1]
        if command == 'compress':
            compress(sys.argv[2], sys.argv[3:])
        elif command == 'extract':
            extract(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else 'all')
        elif command == 'list':
            listing(sys.argv[2])
        else:
            raise ValueError('Unknown command.')
    except (zipfile.BadZipFile, tarfile.TarError, EOFError) as error:
        say(error=f'This archive is damaged or isn\'t really an archive. ({error})')
        sys.exit(1)
    except PermissionError:
        say(error='No permission to write here.')
        sys.exit(1)
    except OSError as error:
        say(error='The house is out of space.' if error.errno == 28 else str(error.strerror or error))
        sys.exit(1)
    except Exception as error:  # noqa: BLE001 - every problem goes back to the panel in plain words
        say(error=str(error))
        sys.exit(1)


if __name__ == '__main__':
    main()
