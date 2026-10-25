#!/usr/bin/env python3
"""Portable, explicit-scope context loader. Not an OS security sandbox."""
import argparse, hashlib, json, os, re, shutil, sys
from pathlib import Path, PurePosixPath
ROOT = Path(__file__).resolve().parents[1]
DOMAINS = ('Personal', 'YB', 'Dimaggi')
CONTEXTS = DOMAINS + ('Global',)
class BoundaryError(Exception): pass

def safe(root, relative):
    if not isinstance(relative, str) or not relative.strip(): raise BoundaryError('Invalid path')
    part = PurePosixPath(relative)
    if part.is_absolute() or not part.parts or any(x in ('..', '.') or x.startswith('.') or x == 'Archive' for x in part.parts):
        raise BoundaryError('Unapproved path')
    p = root
    for x in part.parts:
        p = p / x
        if p.is_symlink(): raise BoundaryError('Linked input refused')
    if not p.resolve().is_relative_to(root.resolve()): raise BoundaryError('Path outside scope')
    return p

def load(root, rel):
    return json.loads(safe(root, rel).read_text())

def approved(root, domain):
    if domain not in CONTEXTS: raise BoundaryError('Select an explicit context')
    manifests = [] if domain == 'Global' else [(f'{domain}/State/sources.json', (domain,))]
    manifests.append(('Global/sources.json', ('Global',)))
    result = []
    for manifest, prefixes in manifests:
        data = load(root, manifest)
        if not isinstance(data, dict) or not isinstance(data.get('files'), list):
            raise BoundaryError('Invalid source manifest')
        for row in data['files']:
            if not isinstance(row, dict) or not isinstance(row.get('sha256'), str) or not re.fullmatch(r'[0-9a-f]{64}', row['sha256']):
                raise BoundaryError('Invalid source entry')
            rel = row.get('path')
            p = safe(root, rel)
            if PurePosixPath(rel).parts[0] not in prefixes: raise BoundaryError('Source outside selected scope')
            raw = p.read_bytes()
            if hashlib.sha256(raw).hexdigest() != row['sha256']: raise BoundaryError('Source changed; review required')
            result.append((rel, raw))
    if len({x[0] for x in result}) != len(result): raise BoundaryError('Duplicate source entry')
    return result

def bind(root, domain, session):
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', session): raise BoundaryError('Invalid session identifier')
    # Claim a session once across contexts. Stores no domain content.
    lock = root / 'Runtime' / 'Bindings'
    if lock.is_symlink() or (root/'Runtime').is_symlink(): raise BoundaryError('Invalid runtime location')
    lock.mkdir(parents=True,exist_ok=True)
    p = lock / (session+'.json')
    expected = hashlib.sha256(domain.encode()).hexdigest()
    try:
        with p.open('x') as f: json.dump({'context_hash':expected},f)
    except FileExistsError:
        if p.is_symlink() or json.loads(p.read_text()).get('context_hash') != expected:
            raise BoundaryError('Session context mismatch; start a fresh session')

def context(root, domain, session):
    rows=approved(root,domain);bind(root,domain,session)
    return '\n\n'.join(f'--- {rel} ---\n'+raw.decode('utf8') for rel,raw in rows)

def inventory(root,domain):
    rows=approved(root,domain)
    return {'context':domain,'approved_files':len(rows),'bytes':sum(len(raw) for _,raw in rows),'files':[rel for rel,_ in rows]}

def export(root,domain,dest):
    rows=approved(root,domain)
    dest=dest.absolute()
    if dest.exists() or dest.is_symlink(): raise BoundaryError('Destination must not exist')
    # No prior export or sibling files can be retained in a newly created target.
    for p in [dest.parent,*dest.parent.parents]:
        if p.is_symlink(): raise BoundaryError('Linked destination refused')
    dest.mkdir(parents=True)
    try:
        for rel,raw in rows:
            p=dest/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(raw)
        for rel in (['Global/sources.json','Tools/brain.py'] if domain == 'Global' else [f'{domain}/State/sources.json','Global/sources.json','Tools/brain.py']):
            p=dest/rel;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(safe(root,rel).read_bytes())
        (dest/'README.md').write_text(f'# Scoped knowledge package\n\nContext: {domain}. Start a fresh agent session.\nRun `python3 Tools/brain.py context --domain {domain} --session NEW_SESSION_ID` and give the resulting context to the agent.\nOnly approved content is included. The administrative archive and other context data are absent.\n')
        approved(dest,domain)
    except Exception:
        shutil.rmtree(dest);raise
    return {'exported_files':len(rows),'context':domain}

def install(root,home):
    # Link only canonical procedures, preserving any existing installation.
    names=sorted(p.parent.name for p in (root/'Global/Skills').glob('qa-*/SKILL.md'))+['dreaming']
    specs=[(n,root/'Global/Skills'/n) for n in names if n!='dreaming']+[('dreaming',root/'Global/Skills/dreaming')]
    target=home/'.agents/skills';target.mkdir(parents=True,exist_ok=True)
    for n,src in specs:
        safe(root,str(src.relative_to(root)))
        if not (src/'SKILL.md').is_file(): raise BoundaryError('Skill missing')
        dst=target/n
        if dst.exists() or dst.is_symlink():
            if dst.is_symlink() and dst.resolve()==src.resolve(): continue
            raise BoundaryError('Existing installation preserved; resolve conflict explicitly')
    for n,src in specs:
        dst=target/n
        if not dst.is_symlink():dst.symlink_to(src,target_is_directory=True)
    return {'linked_skills':len(specs)}

def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='cmd',required=True)
    for cmd in ('context','inventory','export'):
        q=sub.add_parser(cmd);q.add_argument('--domain',required=True,choices=CONTEXTS)
        if cmd=='context':q.add_argument('--session',required=True)
        if cmd=='export':q.add_argument('--output',required=True,type=Path)
    q=sub.add_parser('install');q.add_argument('--home',type=Path,default=Path.home())
    a=p.parse_args()
    try:
        if a.cmd=='context':print(context(ROOT,a.domain,a.session))
        elif a.cmd=='inventory':print(json.dumps(inventory(ROOT,a.domain)))
        elif a.cmd=='export':print(json.dumps(export(ROOT,a.domain,a.output)))
        else:print(json.dumps(install(ROOT,a.home)))
    except (BoundaryError,OSError,KeyError,ValueError,TypeError) as e:
        # No sensitive path, sibling content or raw exception details on failure.
        print('Context operation refused; inspect the selected scope configuration.',file=sys.stderr);return 2
    return 0
if __name__=='__main__':sys.exit(main())
