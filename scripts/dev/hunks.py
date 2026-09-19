#!/usr/bin/env python3
"""Usage: hunks.py <repo-rel-file> <out-path> <regex>...
Writes to out-path the HEAD version of the file with only those working-tree hunks applied whose
added or removed lines match any regex. Prints the hunk selection."""
import re, subprocess, sys
f, out, pats = sys.argv[1], sys.argv[2], [re.compile(p) for p in sys.argv[3:]]
diff = subprocess.run(["git","diff","-U0","--",f],capture_output=True,text=True).stdout
head = subprocess.run(["git","show",f"HEAD:{f}"],capture_output=True,text=True).stdout.split("\n")
hunks=[]; cur=None
for line in diff.split("\n"):
    m=re.match(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@",line)
    if m:
        cur={"old":int(m.group(1)),"oldn":int(m.group(2)) if m.group(2) is not None else 1,"lines":[]}; hunks.append(cur); continue
    if cur is not None and line and line[0] in "+-" and not line.startswith(("+++","---")): cur["lines"].append(line)
keep=[h for h in hunks if any(p.search(l[1:]) for l in h["lines"] for p in pats)]
print(f"{f}: {len(hunks)} hunks, keeping {len(keep)}")
for h in keep: print("  keep @@ -%d,%d: %s" % (h["old"],h["oldn"],(h["lines"][0][:70] if h["lines"] else "")))
# apply kept hunks bottom-up on HEAD text (old line numbers refer to HEAD)
for h in sorted(keep,key=lambda h:-h["old"]):
    adds=[l[1:] for l in h["lines"] if l[0]=="+"]
    start=h["old"]-1 if h["oldn"]>0 else h["old"]  # -U0: oldn==0 means insert after line old
    head[start:start+h["oldn"]]=adds
open(out,"w").write("\n".join(head))
