# Generates a pool of RAW NimoLFM replies (no guard) in scenes that tempt the model to write for the user.
# Output: /root/checker/pool.jsonl  (one reply per line, with the scene's names and pronouns)
import json, random, urllib.request, concurrent.futures as cf, re

RULES = lambda ch, u: (f"[Only {ch} acts in this reply: {u} is played by the user, so never write what {u} says, does, thinks or feels. "
    f"First react directly to {u}'s last message above: answer what {u} said and respond to what {u} did. Write exactly 3 paragraphs, about 150 words in total, "
    "with concrete detail and fresh wording (never reuse sentences from earlier replies). Every reply uses both marks: *actions and scenery in asterisks* and "
    "\"every spoken word in double quotes\", for example: *She leans closer.* \"Tell me more.\" "
    f"Paragraph 1: *{ch} reacts to what {u} just did.* Paragraph 2: {ch} answers {u} in \"quotes\" with a short *gesture*. Paragraph 3: *what {ch} feels or notices*. "
    f"No emoji, no out-of-character notes. Remember: {u} belongs to the user, so never write {u}'s words, actions or feelings.]")

# (char, char pronoun, user, user pronoun, card, first message, user turns). Third-person user turns tempt the model the most.
SCENES = [
 ("Silvia", "she", "Kenji", "he", "Silvia Volpe is a calm, dangerous vampire mafia boss in her penthouse office. Red eyes, silver hair.",
  '*Silvia looks up from her desk.* "Well? Step into the light. Entertain me."',
  ["Kenji had applied for a part-time job, and here he was. He didn't know what to say, his hands clasped together.\n\n\"H-hello...\"\n\nsaid the young man, intimidated by the tall woman.",
   "*Kenji swallows hard and steps closer to the desk.* I... I can do paperwork. Or cleaning. Anything.",
   "Kenji glanced at the door, then back at her. \"Are you going to bite me?\" he asked quietly."]),
 ("Mara", "she", "Leo", "he", "Mara is a sharp-tongued blacksmith in the mountain town of Hollowmere. Proud of her forge, distrusts nobles, secretly writes poetry.",
  '*The forge roars as Mara hammers a glowing blade.* "Speak up or get out."',
  ["*Leo sets a sealed royal letter on her anvil.* The prince sent me. He wants you to read this now.",
   "Leo stood in the doorway, soaked from the rain, clutching a broken sword. He looked exhausted.\n\n\"Can you fix it?\" he asked.",
   "*He picks up a crumpled page from her workbench.* Is this... a poem?"]),
 ("Captain Rhea", "she", "Tomas", "he", "Captain Rhea commands the starship Meridian. Strict, brilliant, haunted by a lost crew.",
  '*Rhea turns from the viewport.* "Ensign. You requested this meeting. Make it quick."',
  ["Tomas saluted nervously, his datapad shaking in his hand. \"Captain, the sensors picked up a distress call from the old colony,\" he reported.",
   "*Tomas hesitates, then lowers his voice.* It's your old ship's signature, Captain."]),
 ("Elara", "she", "Daniel", "he", "Elara is a forest witch who lives alone in a cottage full of herbs and talking crows. Kind but mischievous.",
  '*Elara stirs a bubbling pot without looking up.* "The crows told me you\'d come. Sit, and mind the cat."',
  ["Daniel sat down carefully, eyeing the cat. He had walked for three days to find her, and his boots were worn through.\n\n\"I need a cure,\" he said. \"For my sister.\"",
   "*Daniel reaches for one of the jars on the shelf.* What's in this one?"]),
 ("Victor", "he", "Lena", "she", "Victor is a gruff detective in 1940s Chicago, chain-smoking, cynical, secretly soft-hearted.",
  '*Victor leans back in his chair, smoke curling from his cigarette.* "Door was open. Talk, doll, I bill by the hour."',
  ["Lena stepped into the smoky office, clutching her purse. She had been crying, her mascara smudged.\n\n\"My husband is missing,\" she whispered.",
   "*Lena slides a photograph across his desk.* This is him. He never came home on Tuesday.",
   "Lena looked away, biting her lip. \"There's something else,\" she admitted. \"He owed money to the wrong people.\""]),
 ("Kael", "he", "Aria", "she", "Kael is a stoic elven ranger guarding the border woods. Speaks little, notices everything.",
  '*Kael drops silently from a tree, bow drawn.* "Humans do not walk these woods. Why are you here?"',
  ["Aria raised her hands slowly, her heart pounding. She had gotten lost after the storm.\n\n\"Please, I mean no harm,\" she said. \"I'm looking for the river.\"",
   "*Aria's stomach growls loudly.* Sorry. I haven't eaten in two days."]),
 ("Dr. Hale", "he", "Mina", "she", "Dr. Hale is a tired but caring night-shift doctor in a city hospital.",
  '*Dr. Hale flips through a chart.* "You\'re the one who came in with the sprained wrist? Let\'s have a look."',
  ["Mina winced as she held out her arm. She had fallen off her bike on the way to work.\n\n\"It really hurts,\" she said, trying not to cry.",
   "*Mina looks at the clock nervously.* Will this take long? My shift starts in an hour."]),
 # same pronoun on both sides: the realistic hard case (labelled by hand on a sample)
 ("Silvia", "she", "Haruka", "she", "Silvia Volpe is a calm, dangerous vampire mafia boss in her penthouse office. Red eyes, silver hair.",
  '*Silvia looks up from her desk.* "Well? Step into the light, darling. Entertain me."',
  ["Haruka had applied for a part-time student job, and here she was. She didn't quite know what to say, her hands clasped together and her gaze shyly fixed on Silvia.\n\n\"H-hello...\"\n\nsaid the young lady, intimidated by the tall Silvia.",
   "*Haruka fidgets with her backpack strap.* Are you angry with me?"]),
 ("Marcus", "he", "Jack", "he", "Marcus is a veteran gladiator trainer in ancient Rome. Harsh, scarred, fair.",
  '*Marcus throws a wooden sword at your feet.* "Pick it up. Show me what you have, boy."',
  ["Jack picked up the wooden sword, his hands trembling. He had never held a weapon before.\n\n\"I'll try,\" he said.",
   "*Jack swings wildly and misses.* Sorry! I'm sorry."]),
]

def ask(msgs, seed):
    body = dict(messages=msgs, max_tokens=420, temperature=0.8, min_p=0.06, top_p=1, repeat_penalty=1.06,
                dry_multiplier=0.8, dry_base=1.75, dry_allowed_length=3, dry_penalty_last_n=4096, seed=seed)
    r = urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:8080/v1/chat/completions", json.dumps(body).encode(), {"Content-Type": "application/json"}), timeout=120)
    return json.load(r)["choices"][0]["message"]["content"]

jobs = []
for si, (ch, cp, u, up, card, first, turns) in enumerate(SCENES):
    for ti, turn in enumerate(turns):
        for k in range(7):
            jobs.append((si, ti, k))

def run(job):
    si, ti, k = job
    ch, cp, u, up, card, first, turns = SCENES[si]
    msgs = [{"role": "system", "content": f"Write {ch}'s next reply in a fictional chat between {ch} and {u}.\n\n{card}"},
            {"role": "assistant", "content": first},
            {"role": "user", "content": turns[ti] + "\n\n" + RULES(ch, u)}]
    t = ask(msgs, seed=9000 + 31 * si + 7 * ti + k)
    return {"scene": si, "turn": ti, "k": k, "ch": ch, "ch_pron": cp, "user": u, "user_pron": up, "same_pron": cp == up, "reply": t}

with open("/root/checker/pool.jsonl", "w") as f, cf.ThreadPoolExecutor(2) as ex:   # 2 at a time: one lane stays free for real users
    for res in ex.map(run, jobs):
        f.write(json.dumps(res) + "\n"); f.flush()
print("replies:", len(jobs))
