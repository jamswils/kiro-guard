# Kiro Guard

**A friendly screen guard for your PC.** Tap a hotkey and a calm full-screen
cover slides over everything, with a little character that shows you when your
work is running, paused, or finished. Tap to bring it back. That's it.

Think of it as a "back in a sec" sign for your screen.

---

## Why you'd want it

- You step away from your desk and don't want people reading your screen.
- Something is running and you'd like a tidy "busy" screen instead of a messy desktop.
- You just like a clean, calm cover you can throw up with one key.

It stays out of your way the rest of the time — it lives quietly down by your
clock (the system tray) until you call it.

---

## Get started in 3 steps

You don't need to be technical. Just follow along.

**1. Download it**

Go to the project page and download the latest version:
https://github.com/jamswils/kiro-guard

**2. Run it**

Double-click **`Launch Kiro Guard.bat`**. A little shield icon appears down by
your clock. You're ready.

**3. Use it**

- Press **Ctrl + Shift + L** to cover your screen.
- Press it again to bring your screen back.

That's the whole thing.

---

## The buttons you'll actually use

| What you want | What to press |
|---|---|
| Cover my screen | **Ctrl + Shift + L** |
| Bring my screen back | **Ctrl + Shift + L** again |
| Help, I'm stuck — just unlock! | **Ctrl + Shift + Alt + U** |

You can also right-click the little shield icon by your clock to cover, uncover,
and change settings.

---

## Make it yours (optional)

Right-click the tray icon and open **Settings** to turn these on or off:

- **Ask for my password to unlock** — asks for your Windows password before
  your screen comes back. **On by default.** Untick it if you only want a
  visual cover that opens with a single click (the lock screen will say so).
- **Cover automatically when work starts** — throws the cover up on its own the
  moment a task kicks off. Handy if you wander off a lot.
- **Show the timer** — a small clock showing how long the screen has been
  covered.

Prefer a different hotkey? You can change it in the settings file at
`Documents` ... actually, easiest is to just ask in the project's Issues page
and we'll help. No need to edit anything scary.

---

## Good to know (the honest bit)

Kiro Guard is a **friendly cover, not a vault.** It's perfect for "I've stepped
away" moments. It is **not** meant to protect a laptop from someone determined
to get in — there's a built-in escape hatch (**Ctrl + Shift + Alt + U**) so you
can always get back to your screen.

For serious security (leaving a laptop in public, sensitive work), use Windows'
own lock: press the **Windows key + L**. Kiro Guard sits happily on top of your
normal setup; it doesn't replace it.

---

## If something doesn't work

- **Nothing happens when I double-click the launcher.** Give it a few seconds
  the first time. If a screen flashes and closes, that's usually fine — look for
  the shield icon by your clock.
- **The cover won't go away.** Press **Ctrl + Shift + Alt + U**. That always
  brings your screen back.
- **Still stuck?** Open an issue and describe what happened — screenshots help:
  https://github.com/jamswils/kiro-guard/issues

---

## For the curious / tinkerers

Kiro Guard is built on top of [Kiro Buddy](https://github.com/Jagatees/kiro-buddy)
— the little floating companion that reacts to what your Kiro agent is doing. The
character animations, status system, and hook integration all come from that
project. Kiro Guard wraps it in a screen-cover experience for Windows.

If you want to build it yourself instead of just running it, you'll need
[Node.js](https://nodejs.org/) (version 18 or newer). Then:

```bash
git clone https://github.com/jamswils/kiro-guard.git
cd kiro-guard
npm install
npm run build
```

Launch with **`Launch Kiro Guard.bat`** (it's set up to work smoothly on managed
work laptops). Everything is Windows-first.

---

## License

MIT — free to use, change, and share. See the `LICENSE` file. Made by James Wilson.
