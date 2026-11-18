# NimoLFM checker (fine-tuned Qwen3-0.6B)

A tiny model that answers one question per sentence of a NimoLFM reply: *is the AI writing the user's character here?*
The gateway (`server/lfm.js`) asks it about every sentence the name guard lets through, before the sentence is sent.
It runs as `lfm-checker` (llama-server, port 8081) next to the main model; if it is down, the gateway uses the name guard alone.

How it was made (all synthetic data, no user chats):

1. `gen.py` / `gen2.py` (+ `scenes2.json`): raw NimoLFM replies, no guard, in scenes built to tempt it to write for the user (run on the model server).
2. `build.py` (uses the helpers in `evalc.py`): splits replies into sentences and labels them automatically. In scenes where the
   two characters have different pronouns, the subject tells who acts ("he ..." = the user, "she ..." = the AI's character).
   Whole scenes are held out for the test.
3. `augment.py`: rewrites the AI character's pronouns so both characters share one ("she"/"she"), keeping the labels, so the model learns the hard case.
4. `train.py`: full fine-tune of Qwen3-0.6B, loss on the YES/NO answer only (2 epochs, ~4 min on a 16 GB GPU). Then
   `convert_hf_to_gguf.py --outtype q8_0` from llama.cpp.

Held-out scenes (v2, threshold 0.95): ~85% of user-voiced sentences caught (79% when both characters are "she"), ~1.2% of good sentences flagged, ~80 ms per check.
