# catalog-v3: same entries as catalog-v2 (sha ce30f5f6...), description re-parsed from each SKILL.md
# with YAML block-scalar support (catalog_v2.py read only the first line, so `description: >-` stayed ">-").
import json,re,hashlib,sys
sys.path.insert(0,"/workspace/omk-eval-091")
from fm import parse
v2=json.load(open("/workspace/omk-eval-091/catalog-v2.json"))
fixed=0;missing=[]
out=[]
for c in v2:
    c=dict(c)
    if c["desc"].strip() in (">","|",">-","|-",">+","|+",""):
        try:
            d,_=parse(c["path"])
        except FileNotFoundError:
            missing.append(c["name"]); out.append(c); continue
        if d: c["desc"]=d; fixed+=1
    out.append(c)
json.dump(out,open("catalog-v3.json","w"),ensure_ascii=False,indent=1)
bad=[c["name"] for c in out if not c["disabled"] and c["desc"].strip() in (">","|",">-","|-","")]
print("fixed",fixed,"missing",missing,"still_bad_selectable",bad)
print("sha",hashlib.sha256(open("catalog-v3.json","rb").read()).hexdigest())
