<p align="center">the</i></p>
<p align="center"><img src="https://github.com/neynt/toebeans/raw/refs/heads/main/toebeans.png" width="400px"></p>
<p align="center">manifesto<br><i>everything in this manifesto is human-written.</i></p>

i tried [openclaw](https://github.com/openclaw/openclaw). it has a very
polished onboarding script that gave you the invigorating rush of *creating
life* -- seeing my little bot be so happy when connecting to moltbook for the
first time brought an unbelievably large smile to my face -- but i quickly ran
into issues. there was a focus on scope over quality that pervaded my every
interaction with it. the discord plugin had a bug where it wouldn't send you
any messages until the full agent turn was done, and then it'd give you a
firehose of everything all at once. tts was limited to APIs and low-quality
local options -- not qwen3-tts, which felt like it ought to be trivial to set
up. and somehow it chewed through hundreds of dollars of API credits in the
blink of an eye. it insisted on DIYing code and its tools for spawning headless
coding agents felt quite undercooked. browser integration was also messy -- why
do i need an extension into an existing browser when you can just playwright
everything? it had two systems for scheduling events -- heartbeats and cron --
which felt at once uninspectable and wholly unnecessary. before long its
workspace directory was a mess of incomprehensible yaml files and duct-taped
together ad-hoc workflows it created for functionality that ought to be more
structured. i had no idea what was feeding into the context window at any given
point in time, or when it would decide to compact, or create a new session. and
of course the nest of bitcoin jackers on molthub was terrifying.

i have plenty of grievances. but none of that should detract from my gratitude
for openclaw existing in the first place -- it showed us all what's possible in
an extraordinarily visceral way.

[nanoclaw](https://github.com/gavrielc/nanoclaw.git) seemed like a step in the
right direction. i admire its simplicity. but i think it goes a little too far
-- the extensibility story felt unsustainable. the idea that the way you extend
the agent is to tell it to modify its own code, and that is the *only way* to
extend the agent, felt like a mess of compositional difficulties waiting to
happen.

so here's my commitment to creating an assistant that's at the same time deeply
extensible and comprehensible. toebeans will be an assistant with:

- **a solid, minimal core**. the main agent loop seldom needs to change and
  provides little functionality on its own.
- **deep extensibility**. plugins can hook into a thoughtful selection of
  extension points in the agent loop and extend functionality. concepts that
  other assistants treat as rigid parts of the core, such as memory and timers,
  are interchangeable plugins you can swap in and out or create your own
  versions of.
- **high quality built-in plugins**. i have exacting standards for my software
  and will polish the hell out of whatever i actually use.
- **deep inspectability**. every action and message is logged in
  `~/.toebeans/`. every active timer, recurring or one-shot, is just a markdown
  file. knowledge is just markdown files. every session is just a jsonl file.
  you should always be able to peel back the layers of abstraction and ask
  qustions like "ok, but what exactly is in the context window at this point in
  time", without going through an llm.
- **careful context window management**. maintain a thoughtfully curated
  context window. this is good for performance and for the user's wallet.
