"""Adds SAME-pronoun examples (both characters "she", or both "he") with labels we know are right.
Each sentence in a different-pronoun scene is labelled by its subject (the user's pronoun -> YES, the AI character's -> NO);
we rewrite the AI character's pronouns to match the user's, so both read "she" (or "he"), and keep the label.
The model then has to tell them apart from context, like in a real Haruka/Silvia scene.
"""
import json, re, random
random.seed(1)
MAP = {'he': {'he': 'she', 'him': 'her', 'his': 'her', 'himself': 'herself'}, 'she': {'she': 'he', 'her': 'his', 'hers': 'his', 'herself': 'himself'}}

def swap(text, frm):
    m = MAP[frm]
    def rep(w):
        t = m[w.group(0).lower()]
        return t.capitalize() if w.group(0)[0].isupper() else t
    return re.sub(r"\b(" + "|".join(m) + r")\b", rep, text, flags=re.I)

rows = [json.loads(l) for l in open('dataset.jsonl', encoding='utf-8')]
pool = {}
for name in ('pool', 'pool2'):
    for l in open(f'{name}.jsonl', encoding='utf-8'):
        r = json.loads(l); pool.setdefault(f"{name}:{r['scene']}", r)
add = []
for r in rows:
    meta = pool[r['scene']]
    if meta['same_pron']:
        continue
    p = r['prompt']
    # the prompt quotes "Earlier in the AI's reply" and the sentence: swap the AI character's pronouns in those parts only
    head, rest = p.split('Earlier in the AI\'s reply:', 1)
    body, tail = rest.split('Question:', 1)
    # a sentence whose subject is a pronoun keeps its label; only the AI character's pronouns change
    new_body = swap(body, meta['ch_pron']) if meta['ch_pron'] != meta['user_pron'] else body
    # the user's own pronouns are already the target ones, but swapping the char's turned them the same: good.
    # Avoid mixing: if the original body contains the user's pronoun, swapping the char's pronoun could not touch it.
    if new_body == body:
        continue
    add.append({**r, 'prompt': head + "Earlier in the AI's reply:" + new_body + 'Question:' + tail, 'aug': 'same_pron'})
with open('dataset_aug.jsonl', 'w', encoding='utf-8') as f:
    for r in rows + add:
        f.write(json.dumps(r) + '\n')
tr = [a for a in add if a['split'] == 'train']; te = [a for a in add if a['split'] == 'test']
print(f"added {len(add)} same-pronoun examples: train {len(tr)} ({sum(a['label'] for a in tr)} YES), test {len(te)} ({sum(a['label'] for a in te)} YES)")
