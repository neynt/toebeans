# teensy-embodiment

Physical hardware plugin for toebeans. Connects to a Teensy 4.1 microcontroller over USB serial to provide LCD displays, microphone input, and (eventually) speaker output.

## Hardware

- **Teensy 4.1** — main MCU, connected via USB serial (`/dev/ttyACM0`)
- **ST7789V** 240×320 rect LCD — text/status display, on SPI0
- **GC9A01** 240×240 round LCD — avatar display, on SPI1
- **INMP441** I2S MEMS microphone — audio input
- **STEMMA speaker** (planned) — audio output via MQS

## Firmware

The teensy firmware is in `src/main.cpp` with `platformio.ini`. build and flash with:

```bash
cd ~/.toebeans/plugins/teensy-embodiment
pio run --target upload
```

## Serial protocol

Binary protocol over USB serial at 115200 baud.

**Teensy → Host:**
- `\x01` + 2-byte LE length + raw PCM bytes (audio frame)
- `\x02` + JSON + `\n` (event)

**Host → Teensy:**
- JSON + `\n` (command)
  - `{"cmd":"display","text":"hello"}` — show text on rect LCD

## Data

Runtime data is stored in `~/.toebeans/teensy-embodiment/`:
- `audio/` — recorded PCM files (44100Hz 16-bit signed LE mono)

## Config

In `~/.toebeans/config.json5`:

```json5
'teensy-embodiment': {
  serialPort: '/dev/ttyACM0',  // optional, default shown
}
```

## Pin assignments

### Rect LCD (ST7789V) — SPI0
| LCD pin | Teensy pin |
|---------|-----------|
| DIN     | 11        |
| CLK     | 13        |
| CS      | 37        |
| DC      | 36        |
| RST     | 35        |

### Round LCD (GC9A01) — SPI1
| LCD pin | Teensy pin |
|---------|-----------|
| SDA     | 26        |
| SCL     | 27        |
| CS      | 38        |
| DC      | 34        |
| RES     | 33        |

### Mic (INMP441) — I2S
| Mic pin | Teensy pin |
|---------|-----------|
| SD      | 8         |
| SCK     | 21        |
| WS      | 20        |
| L/R     | GND       |

### Speaker (planned)
| Speaker | Teensy pin |
|---------|-----------|
| Signal  | 10 (MQS)  |

### Power
All peripherals on 3.3V rail. Speaker on Vin (5V USB).
