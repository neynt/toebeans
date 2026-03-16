#include <Adafruit_GFX.h>
#include <Adafruit_ST7789.h>
#include <Arduino_GFX_Library.h>
#include <SPI.h>
#include <Audio.h>

// Rect LCD (ST7789V) on SPI0
#define RECT_CS  37
#define RECT_DC  36
#define RECT_RST 35
#define RECT_W 240
#define RECT_H 320

// Round LCD (GC9A01) on SPI1
#define ROUND_CS  38
#define ROUND_DC  34
#define ROUND_RST 33
#define ROUND_MOSI 26
#define ROUND_CLK  27
#define ROUND_W 240
#define ROUND_H 240

// Protocol bytes
#define MSG_AUDIO 0x01
#define MSG_EVENT 0x02

// Audio pipeline
AudioInputI2S        i2sIn;
AudioOutputI2S       i2sOut;
AudioRecordQueue     queue;
AudioConnection      patchCord1(i2sIn, 0, queue, 0);

Adafruit_ST7789 rectLcd = Adafruit_ST7789(RECT_CS, RECT_DC, RECT_RST);
GFXcanvas16 rectCanvas(RECT_W, RECT_H);

Arduino_DataBus *roundBus = new Arduino_HWSPI(ROUND_DC, ROUND_CS, &SPI1);
Arduino_GC9A01 *roundLcdRaw = new Arduino_GC9A01(roundBus, ROUND_RST, 0, true);
Arduino_Canvas *roundLcd = new Arduino_Canvas(ROUND_W, ROUND_H, roundLcdRaw);

#define NUM_STARS 40
struct Star { float x, y, speed; uint16_t color; };
Star stars[NUM_STARS];

uint16_t pink, white, black, nose_color, darkBlue;

// incoming command buffer
char cmdBuf[512];
int cmdLen = 0;

void initStar(Star &s) {
  s.x = random(ROUND_W);
  s.y = random(ROUND_H);
  s.speed = 0.5 + random(100) / 50.0;
  s.color = 0xFFE0;
}

void drawCatHead(Arduino_GFX *c, int cx, int cy, bool blink) {
  c->fillCircle(cx, cy, 60, white);
  c->fillTriangle(cx - 55, cy - 45, cx - 35, cy - 80, cx - 15, cy - 45, white);
  c->fillTriangle(cx + 55, cy - 45, cx + 35, cy - 80, cx + 15, cy - 45, white);
  c->fillTriangle(cx - 48, cy - 48, cx - 35, cy - 72, cx - 22, cy - 48, pink);
  c->fillTriangle(cx + 48, cy - 48, cx + 35, cy - 72, cx + 22, cy - 48, pink);
  if (blink) {
    c->drawLine(cx - 32, cy - 10, cx - 12, cy - 10, black);
    c->drawLine(cx + 12, cy - 10, cx + 32, cy - 10, black);
  } else {
    c->fillCircle(cx - 22, cy - 10, 10, black);
    c->fillCircle(cx + 22, cy - 10, 10, black);
    c->fillCircle(cx - 19, cy - 13, 3, white);
    c->fillCircle(cx + 25, cy - 13, 3, white);
  }
  c->fillTriangle(cx, cy + 8, cx - 6, cy + 2, cx + 6, cy + 2, nose_color);
  c->drawLine(cx, cy + 8, cx - 10, cy + 18, black);
  c->drawLine(cx, cy + 8, cx + 10, cy + 18, black);
  c->drawLine(cx - 20, cy + 5, cx - 55, cy - 2, black);
  c->drawLine(cx - 20, cy + 10, cx - 55, cy + 10, black);
  c->drawLine(cx - 20, cy + 15, cx - 55, cy + 22, black);
  c->drawLine(cx + 20, cy + 5, cx + 55, cy - 2, black);
  c->drawLine(cx + 20, cy + 10, cx + 55, cy + 10, black);
  c->drawLine(cx + 20, cy + 15, cx + 55, cy + 22, black);
}

void sendAudio(int16_t *buf, uint16_t len) {
  uint8_t header[3];
  header[0] = MSG_AUDIO;
  header[1] = len & 0xFF;
  header[2] = (len >> 8) & 0xFF;
  Serial.write(header, 3);
  Serial.write((uint8_t *)buf, len);
}

void sendEvent(const char *json) {
  Serial.write(MSG_EVENT);
  Serial.print(json);
  Serial.write('\n');
}

void displayText(const char *text) {
  rectCanvas.fillScreen(black);
  rectCanvas.setTextColor(white);
  rectCanvas.setTextSize(2);
  rectCanvas.setCursor(10, 10);
  rectCanvas.println(text);
  rectLcd.drawRGBBitmap(0, 0, rectCanvas.getBuffer(), RECT_W, RECT_H);
}

// Unescape JSON string escape sequences in-place.
// Handles: \n \t \\ \"
void jsonUnescape(char *s) {
  char *r = s, *w = s;
  while (*r) {
    if (r[0] == '\\' && r[1]) {
      switch (r[1]) {
        case 'n':  *w++ = '\n'; r += 2; break;
        case 't':  *w++ = '\t'; r += 2; break;
        case '\\': *w++ = '\\'; r += 2; break;
        case '"':  *w++ = '"';  r += 2; break;
        case '/':  *w++ = '/';  r += 2; break;
        default:   *w++ = *r++; break; // unknown escape, keep as-is
      }
    } else {
      *w++ = *r++;
    }
  }
  *w = '\0';
}

void handleCommand(const char *json) {
  // minimal JSON parsing — look for "cmd" field
  // format: {"cmd":"display","text":"hello"}
  if (strstr(json, "\"display\"")) {
    const char *textStart = strstr(json, "\"text\":\"");
    if (textStart) {
      textStart += 8; // skip "text":"
      char text[256];
      int i = 0, j = 0;
      while (textStart[i] && j < 255) {
        if (textStart[i] == '\\' && textStart[i + 1]) {
          // copy escape sequence intact (jsonUnescape handles it later)
          text[j++] = textStart[i++];
          if (j < 255) text[j++] = textStart[i++];
        } else if (textStart[i] == '"') {
          break; // end of JSON string
        } else {
          text[j++] = textStart[i++];
        }
      }
      text[j] = '\0';
      jsonUnescape(text);
      displayText(text);
    }
  }
}

void readCommands() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n') {
      cmdBuf[cmdLen] = '\0';
      if (cmdLen > 0) handleCommand(cmdBuf);
      cmdLen = 0;
    } else if (cmdLen < (int)sizeof(cmdBuf) - 1) {
      cmdBuf[cmdLen++] = c;
    }
  }
}

void setup() {
  pink = 0xFCB2;
  white = 0xFFFF;
  black = 0x0000;
  nose_color = 0xF814;
  darkBlue = 0x0009;

  for (int i = 0; i < NUM_STARS; i++) initStar(stars[i]);

  AudioMemory(60);
  queue.begin();
  Serial.begin(115200);

  // init rect LCD
  rectLcd.init(RECT_W, RECT_H, SPI_MODE3);
  rectLcd.setSPISpeed(40000000);
  rectLcd.setRotation(2);
  displayText("kanoko v0.1\nready.");

  // init round LCD (static)
  SPI1.setMOSI(ROUND_MOSI);
  SPI1.setSCK(ROUND_CLK);
  roundLcd->begin(2000000);
  roundLcd->fillScreen(darkBlue);
  for (int i = 0; i < NUM_STARS; i++) {
    Star &s = stars[i];
    int sz = s.speed > 1.8 ? 2 : 1;
    roundLcd->fillRect((int)s.x, (int)s.y, sz, sz, s.color);
  }
  drawCatHead(roundLcd, 120, 120, false);
  roundLcd->flush();

  sendEvent("{\"event\":\"ready\"}");
}

void loop() {
  // read incoming commands from host
  readCommands();

  // stream audio with protocol framing
  if (queue.available()) {
    int16_t *buf = queue.readBuffer();
    sendAudio(buf, 256); // 128 samples × 2 bytes
    queue.freeBuffer();
  }
}
