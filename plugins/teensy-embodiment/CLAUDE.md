# teensy-embodiment — agent notes

## Firmware vs. plugin

- `index.ts` runs on the **host** (Bun). Changes take effect on server restart.
- `src/main.cpp` runs on the **Teensy 4.1 MCU**. Changes require reflashing the device.

**After any firmware change, you must reflash:**

```bash
cd ~/.toebeans/plugins/teensy-embodiment && pio run --target upload
```

The Teensy must be connected via USB. The plugin auto-discovers the port via `/dev/serial/by-id/` and reconnects automatically after flashing (even if the device re-enumerates to a different `/dev/ttyACMn`).

## What lives where

| File | Runs on | Reload method |
|------|---------|---------------|
| `index.ts` | Host (Bun) | Restart toebeans server |
| `src/main.cpp` | Teensy MCU | `pio run --target upload` |
| `platformio.ini` | PlatformIO build config | Rebuild + upload |

## Common pitfalls

- Editing `main.cpp` without reflashing — the old firmware keeps running.
- **Do NOT put an `index.ts` in `~/.toebeans/plugins/teensy-embodiment/`** — the plugin loader checks the user dir first and will shadow the repo builtin, silently running stale code. The user dir should only contain firmware files (`src/`, `platformio.ini`, `lib/`, `include/`) for PlatformIO builds.
- SPI speed for the round LCD is limited to 2 MHz (GC9A01 is unstable above that).
- Audio samples are 128 per I2S buffer (256 bytes per frame).
