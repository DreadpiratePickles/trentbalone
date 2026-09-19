#!/usr/bin/env python3
"""dropblocks.py <file> <out> <marker>... : the WORKING-TREE version of <file> with every region that starts
with one of the given marker lines removed. A region ends at the next '// [' marker, a line starting with
'personality:', the object closer, or (for import regions) the first blank line."""
import sys
f,out,markers=sys.argv[1],sys.argv[2],set(sys.argv[3:])
w=open(f).read().split("\n"); keep=[]; i=0; dropped=0
while i<len(w):
    if w[i].strip() in markers:
        j=i+1; isimp=j<len(w) and w[j].startswith("import")
        while j<len(w):
            s=w[j].strip()
            if s.startswith("// [") or s.startswith("personality:") or w[j].startswith("})") or w[j].startswith("};"): break
            if isimp and s=="": break
            j+=1
        dropped+=j-i; i=j
    else: keep.append(w[i]); i+=1
open(out,"w").write("\n".join(keep)); print(f"{f}: dropped {dropped} lines for {sorted(markers)}")
