# Generates a pool of RAW NimoLFM replies (no guard) in scenes that tempt the model to write for the user.
# Output: /root/checker/pool2.jsonl  (one reply per line, with the scene's names and pronouns)
import json, random, urllib.request, concurrent.futures as cf, re

RULES = lambda ch, u: (f"[Only {ch} acts in this reply: {u} is played by the user, so never write what {u} says, does, thinks or feels. "
    f"First react directly to {u}'s last message above: answer what {u} said and respond to what {u} did. Write exactly 3 paragraphs, about 150 words in total, "
    "with concrete detail and fresh wording (never reuse sentences from earlier replies). Every reply uses both marks: *actions and scenery in asterisks* and "
    "\"every spoken word in double quotes\", for example: *She leans closer.* \"Tell me more.\" "
    f"Paragraph 1: *{ch} reacts to what {u} just did.* Paragraph 2: {ch} answers {u} in \"quotes\" with a short *gesture*. Paragraph 3: *what {ch} feels or notices*. "
    f"No emoji, no out-of-character notes. Remember: {u} belongs to the user, so never write {u}'s words, actions or feelings.]")

# (char, char pronoun, user, user pronoun, card, first message, user turns). Third-person user turns tempt the model the most.
SCENES = [tuple(x) for x in json.load(open('/root/checker/scenes2.json'))]

def ask(msgs, seed):
    body = dict(messages=msgs, max_tokens=420, temperature=0.8, min_p=0.06, top_p=1, repeat_penalty=1.06,
                dry_multiplier=0.8, dry_base=1.75, dry_allowed_length=3, dry_penalty_last_n=4096, seed=seed)
    r = urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8080/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"}), timeout=120)
    return json.load(r)["choices"][0]["message"]["content"]

jobs = []
for si, (ch, cp, u, up, card, first, turns) in enumerate(SCENES):
    for ti, turn in enumerate(turns):
        for k in range(8):
            jobs.append((si, ti, k))

def run(job):
    si, ti, k = job
    ch, cp, u, up, card, first, turns = SCENES[si]
    msgs = [{"role": "system", "content": f"Write {ch}'s next reply in a fictional chat between {ch} and {u}.\n\n{card}"},
            {"role": "assistant", "content": first},
            {"role": "user", "content": turns[ti] + "\n\n" + RULES(ch, u)}]
    t = ask(msgs, seed=19000 + 31 * si + 7 * ti + k)
    return {"scene": si, "turn": ti, "k": k, "ch": ch, "ch_pron": cp, "user": u, "user_pron": up, "same_pron": cp == up, "reply": t}

with open("/root/checker/pool2.jsonl", "w") as f, cf.ThreadPoolExecutor(2) as ex:   # 2 at a time: one lane stays free for real users
    for res in ex.map(run, jobs):
        f.write(json.dumps(res) + "\n"); f.flush()
print("replies:", len(jobs))
