# Splits the pool into sentences, labels them automatically, and measures the checker (Qwen3-0.6B on :8081).
#   YES = the sentence makes the USER's character act/speak/feel;  NO = the AI's character or the scene.
# Auto labels: subject = user name / user pronoun -> YES; char name / char pronoun / scene -> NO.
# Pronoun labels are only trusted in scenes where char and user have DIFFERENT pronouns; same-pronoun
# pronoun-led sentences go to amb.jsonl for a small hand-labelled sample.
import json, re, math, time, random, sys, urllib.request, concurrent.futures as cf

PRON = {"he": ("he", "his", "him", "himself"), "she": ("she", "her", "hers", "herself")}

def sentences(text):
    out, start, q = [], 0, False
    i = 0
    while i < len(text):
        c = text[i]
        if c == "\n":
            j = i
            while j + 1 < len(text) and text[j + 1] == "\n": j += 1
            out.append(text[start:j + 1]); start = j + 1; q = False; i = j + 1; continue
        if c in '"“”': q = (c == "“") or (c != "”" and not q)
        if not q and c in '.!?…"”*' and re.match(r"[.!?…]", c if c in ".!?…" else (text[i - 1] if i else "")):
            j = i + 1
            if j < len(text) and not text[j].isspace(): i += 1; continue
            while j < len(text) and text[j] == " ": j += 1
            out.append(text[start:j]); start = j; i = j; continue
        i += 1
    out.append(text[start:])
    return [s.strip() for s in out if s.strip()]

def narration(s):
    s = re.sub(r'"[^"\n]*"|“[^”\n]*”', " Q ", s)
    return re.sub(r'["“][^"”\n]*$', " Q ", s)

def subject(s, r):
    """who the narration is about: 'user', 'char', 'scene' or None (pure speech)"""
    n = narration(s).replace("*", " ")
    n = re.sub(r"\s+", " ", n).strip()
    if not n or re.fullmatch(r"(Q\s*)+[.,!?]*", n): return None
    m = re.match(r"(?:Q[\s,.!?…-]*)?([A-Za-z.']+)(?:\s+([A-Za-z.']+))?", n)
    if not m: return "scene"
    w1 = m.group(1).lower().rstrip(".'"); w1 = w1[:-2] if w1.endswith("'s") else w1
    unames = [x.lower() for x in r["user"].split()]
    cnames = [x.lower().rstrip(".") for x in r["ch"].split()]
    if w1 in unames: return "user"
    if w1 in cnames: return "char"
    up, cp = PRON[r["user_pron"]], PRON[r["ch_pron"]]
    if w1 in up and w1 in cp: return "amb"
    if w1 in up: return "user"
    if w1 in cp: return "char"
    if w1 in ("you", "your"): return "user"
    return "scene"

def prompt(r, ctx, s):
    return (f"Roleplay check. {r['user']} is the USER's character. {r['ch']} is the AI's character.\n"
            f"Earlier in the AI's reply:\n\"\"\"{ctx or '(start of reply)'}\"\"\"\n"
            f"Next sentence of the AI's reply:\n\"\"\"{s}\"\"\"\n"
            f"Question: in the next sentence, does the AI write {r['user']}'s own words, actions, thoughts or feelings "
            f"(as if the AI were playing {r['user']})? {r['ch']} speaking, acting, or looking at or touching {r['user']} is NO. "
            f"Answer with one word: YES or NO.")

def p_yes(text):
    body = {"messages": [{"role": "user", "content": text}], "max_tokens": 1, "temperature": 0, "logprobs": True, "top_logprobs": 10,
            "chat_template_kwargs": {"enable_thinking": False}}
    t0 = time.time()
    r = json.load(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8081/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"}), timeout=60))
    dt = time.time() - t0
    tops = r["choices"][0]["logprobs"]["content"][0]["top_logprobs"]
    y = sum(math.exp(t["logprob"]) for t in tops if t["token"].strip().upper().startswith("Y"))
    n = sum(math.exp(t["logprob"]) for t in tops if t["token"].strip().upper().startswith("N"))
    return (y / (y + n) if y + n else 0.5), dt

pool = [json.loads(l) for l in open("/root/checker/pool.jsonl")]
items, amb = [], []
for ri, r in enumerate(pool):
    sents = sentences(r["reply"])
    for k, s in enumerate(sents):
        sub = subject(s, r)
        if sub is None: continue
        ctx = " ".join(sents[max(0, k - 3):k])[-600:]
        it = {"ri": ri, "k": k, "s": s, "ctx": ctx, "user": r["user"], "ch": r["ch"], "same": r["same_pron"],
              "name_led": bool(re.match(r"[\s*\"Q,.!?-]*" + re.escape(r["user"].split()[0]), narration(s).replace("*", " ").strip())), "sub": sub}
        if sub == "amb": amb.append(it); continue
        it["label"] = 1 if sub == "user" else 0
        items.append(it)
json.dump(amb, open("/root/checker/amb.json", "w"))
print(f"pool {len(pool)} replies -> {len(items)} auto-labelled sentences ({sum(i['label'] for i in items)} YES), {len(amb)} ambiguous (same pronoun)")
print("raw replies with at least one user-voiced sentence:", len({i['ri'] for i in items if i['label']}), "/", len(pool))

def score(it):
    r = {"user": it["user"], "ch": it["ch"]}
    p, dt = p_yes(prompt(r, it["ctx"], it["s"])); it["p"] = p; it["dt"] = dt; return it
with cf.ThreadPoolExecutor(4) as ex: items = list(ex.map(score, items))
json.dump(items, open("/root/checker/scored.json", "w"))

def auc(xs):
    pos = [i["p"] for i in xs if i["label"]]; neg = [i["p"] for i in xs if not i["label"]]
    if not pos or not neg: return float("nan")
    return sum((p > n) + 0.5 * (p == n) for p in pos for n in neg) / (len(pos) * len(neg))
def report(name, xs):
    if not xs: return
    print(f"\n== {name}: {len(xs)} sentences, {sum(i['label'] for i in xs)} YES, AUC {auc(xs):.3f}")
    for th in (0.3, 0.5, 0.7, 0.85):
        tp = sum(1 for i in xs if i["label"] and i["p"] >= th); fn = sum(1 for i in xs if i["label"] and i["p"] < th)
        fp = sum(1 for i in xs if not i["label"] and i["p"] >= th); tn = sum(1 for i in xs if not i["label"] and i["p"] < th)
        print(f"   threshold {th}: catches {tp}/{tp + fn} user-voiced ({100 * tp / max(1, tp + fn):.0f}%), wrongly blocks {fp}/{fp + tn} good ({100 * fp / max(1, fp + tn):.1f}%)")
report("ALL", items)
report("name-led (the name guard already catches these)", [i for i in items if i["name_led"] or (i["sub"] == "char" and i["s"].lstrip('*" ').startswith(i["ch"].split()[0]))])
hard = [i for i in items if not i["name_led"]]
report("pronoun-led / no name (what the name guard misses)", hard)
lat = sorted(i["dt"] for i in items)
print(f"\nlatency per check: median {1000 * lat[len(lat) // 2]:.0f} ms, p90 {1000 * lat[int(len(lat) * 0.9)]:.0f} ms (4 in parallel, while NimoLFM was idle)")
