"""Fine-tunes Qwen3-0.6B into a YES/NO checker: "does this sentence make the AI write the USER's character?"
Full fine-tune (bf16 weights, fp32 AdamW states would be 7 GB, so AdamW on bf16 with a small LR), loss on the answer token only.
usage: python train.py            -> trains, evaluates on held-out scenes, saves ./checker-qwen3-0.6b
"""
import json, math, random, time
import torch, torch.nn.functional as F
from transformers import AutoTokenizer, AutoModelForCausalLM

BASE = 'D:/LLM/nimo-checker/base-qwen3-0.6b'
OUT = 'D:/LLM/nimo-checker/checker-qwen3-0.6b'
random.seed(0); torch.manual_seed(0)
rows = [json.loads(l) for l in open('D:/LLM/nimo-checker/dataset_aug.jsonl', encoding='utf-8')]
train = [r for r in rows if r['split'] == 'train']; test = [r for r in rows if r['split'] == 'test']
print(f"train {len(train)} ({sum(r['label'] for r in train)} YES), test {len(test)} ({sum(r['label'] for r in test)} YES)")

tok = AutoTokenizer.from_pretrained(BASE)
model = AutoModelForCausalLM.from_pretrained(BASE, dtype=torch.bfloat16).cuda()
model.gradient_checkpointing_enable(); model.config.use_cache = False
YES = tok.encode('YES', add_special_tokens=False)[0]; NO = tok.encode('NO', add_special_tokens=False)[0]
HEAD_ROWS = lambda: model.lm_head.weight[[YES, NO]]

def ids(prompt):
    t = tok.apply_chat_template([{'role': 'user', 'content': prompt}], tokenize=False, add_generation_prompt=True, enable_thinking=False)
    return tok(t, add_special_tokens=False)['input_ids'][-1024:]

@torch.no_grad()
def p_yes(batch):
    model.eval(); out = []
    for i in range(0, len(batch), 16):
        seqs = [ids(r['prompt']) for r in batch[i:i + 16]]
        L = max(map(len, seqs))
        x = torch.full((len(seqs), L), tok.pad_token_id); m = torch.zeros_like(x)
        for j, s in enumerate(seqs): x[j, L - len(s):] = torch.tensor(s); m[j, L - len(s):] = 1     # left pad: last position = answer
        h = model.model(input_ids=x.cuda(), attention_mask=m.cuda()).last_hidden_state[:, -1]
        logits = (h @ HEAD_ROWS().T).float()
        out += torch.softmax(logits, -1)[:, 0].tolist()
    return out

def report(name, rs, ps):
    pos = [p for r, p in zip(rs, ps) if r['label']]; neg = [p for r, p in zip(rs, ps) if not r['label']]
    auc = sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / max(1, len(pos) * len(neg))
    print(f"== {name}: {len(rs)} sentences, {len(pos)} YES, AUC {auc:.3f}")
    for th in (0.5, 0.7, 0.85, 0.95):
        tp = sum(p >= th for p in pos); fp = sum(p >= th for p in neg)
        print(f"   threshold {th}: catches {tp}/{len(pos)} user-voiced ({100 * tp / max(1, len(pos)):.0f}%), wrongly blocks {fp}/{len(neg)} good ({100 * fp / max(1, len(neg)):.1f}%)")

# YES is rare (~11%): oversample it 3x so the model doesn't learn "always NO"
data = train + [r for r in train if r['label']] * 2
EPOCHS, BS, LR = 2, 16, 2e-5
opt = torch.optim.AdamW(model.parameters(), lr=LR, weight_decay=0.0)
steps = EPOCHS * math.ceil(len(data) / BS); step = 0; t0 = time.time()
for ep in range(EPOCHS):
    random.shuffle(data); model.train()
    for i in range(0, len(data), BS):
        b = data[i:i + BS]
        seqs = [ids(r['prompt']) + [YES if r['label'] else NO] for r in b]
        L = max(map(len, seqs))
        x = torch.full((len(seqs), L), tok.pad_token_id); m = torch.zeros_like(x)
        for j, s in enumerate(seqs): x[j, :len(s)] = torch.tensor(s); m[j, :len(s)] = 1
        x, m = x.cuda(), m.cuda()
        h = model.model(input_ids=x, attention_mask=m).last_hidden_state
        pos = torch.tensor([len(s) - 2 for s in seqs], device='cuda')          # position that predicts the answer token
        pred = (h[torch.arange(len(seqs), device='cuda'), pos] @ model.lm_head.weight[[YES, NO]].T).float()
        tgt = torch.tensor([0 if r['label'] else 1 for r in b], device='cuda')
        loss = F.cross_entropy(pred, tgt)
        lr = LR * min(1, (step + 1) / 30) * 0.5 * (1 + math.cos(math.pi * step / steps))
        for g in opt.param_groups: g['lr'] = lr
        loss.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step(); opt.zero_grad(); step += 1
        if step % 50 == 0: print(f"  step {step}/{steps} loss {loss.item():.4f}  {time.time() - t0:.0f}s")
    ps = p_yes(test); report(f"held-out scenes after epoch {ep + 1}", test, ps)
report("held-out, SAME pronoun for both characters (the Haruka/Silvia case)", [r for r in test if r.get('aug')], [p for r, p in zip(test, ps) if r.get('aug')])
report("held-out, original different-pronoun sentences", [r for r in test if not r.get('aug')], [p for r, p in zip(test, ps) if not r.get('aug')])
report("held-out, no name in the sentence (what the name guard misses)", [r for r in test if not r['name_led']], [p for r, p in zip(test, ps) if not r['name_led']])
model.config.use_cache = True
model.save_pretrained(OUT, safe_serialization=True); tok.save_pretrained(OUT)
print('saved', OUT)
