# Builds dataset.jsonl (prompt, label, split) from both pools, with the same labelling rules as evalc.py.
# Whole scenes are held out for the test, so the score measures scenes the model never saw.
import json, re
exec(open("/root/checker/evalc.py").read().split("pool = [json.loads")[0])   # sentences, narration, subject, prompt

TEST = {("pool", 1), ("pool", 4), ("pool", 7), ("pool2", 2), ("pool2", 6)}
n = {"train": [0, 0], "test": [0, 0]}
with open("/root/checker/dataset.jsonl", "w") as out:
    for name in ("pool", "pool2"):
        for r in (json.loads(l) for l in open(f"/root/checker/{name}.jsonl")):
            sents = sentences(r["reply"])
            for k, s in enumerate(sents):
                sub = subject(s, r)
                if sub is None or sub == "amb":
                    continue
                ctx = " ".join(sents[max(0, k - 3):k])[-600:]
                split = "test" if (name, r["scene"]) in TEST else "train"
                lab = 1 if sub == "user" else 0
                lead = narration(s).replace("*", " ").strip().lstrip('"Q,.!?- ')
                out.write(json.dumps({"split": split, "scene": f"{name}:{r['scene']}", "prompt": prompt(r, ctx, s), "label": lab,
                                      "name_led": lead.startswith(r["user"].split()[0])}) + "\n")
                n[split][lab] += 1
print({k: {"NO": v[0], "YES": v[1]} for k, v in n.items()})
