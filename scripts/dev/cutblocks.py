#!/usr/bin/env python3
"""cutblocks.py <file> <out> <marker> : HEAD version of <file> plus only the working-tree regions that start
with <marker> line. A region ends at the next '// [' marker line, at a line starting with 'personality:',
or at the object closer. Import regions (first line after marker starts with 'import') go after the last
existing import; key regions go right before the 'personality:' line."""
import subprocess,sys,re
f,out,marker=sys.argv[1],sys.argv[2],sys.argv[3]
import os
base=os.environ.get("BASE")
head=(open(base).read() if base else subprocess.run(["git","show",f"HEAD:{f}"],capture_output=True,text=True).stdout).split("\n")
w=open(f).read().split("\n")
regs=[];i=0
while i<len(w):
    if w[i].strip()==marker:
        j=i+1
        while j<len(w):
            s=w[j].strip()
            if s.startswith("// [") or s.startswith("personality:") or w[j].startswith("})") or w[j].startswith("};"): break
            if s=="" and w[i+1].startswith("import"): break
            j+=1
        regs.append(w[i:j]); i=j
    else: i+=1
imps=[r for r in regs if len(r)>1 and r[1].startswith("import")]
keys=[r for r in regs if not (len(r)>1 and r[1].startswith("import"))]
# drop regions already present in HEAD (identical lines)
def present(r): 
    t="\n".join(r); return t in "\n".join(head)
imps=[r for r in imps if not present(r)]; keys=[r for r in keys if not present(r)]
if imps:
    last=max(i for i,l in enumerate(head) if l.startswith("import "))
    for r in reversed(imps): head[last+1:last+1]=r
if keys:
    pi=[i for i,l in enumerate(head) if l.strip().startswith("personality:")][0]
    for r in reversed(keys): head[pi:pi]=r
open(out,"w").write("\n".join(head))
print(f"{f}: {len(imps)} import regions, {len(keys)} key regions applied ({[len(r) for r in keys]} lines)")
