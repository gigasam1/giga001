#!/usr/bin/env python3
"""코드로 효과음을 합성한다. (numpy만 필요)

사용법:
    python tools/sfx.py --list                    # 만들 수 있는 효과음 목록
    python tools/sfx.py all                       # 전부 audio/sfx/ 에 생성
    python tools/sfx.py footsteps door_slam       # 골라서 생성
    python tools/sfx.py rain --seconds 8 --seed 3 # 길이/랜덤 시드 지정

새 효과음이 필요하면 아래 SOUNDS 에 함수 하나를 추가하면 된다.
함수는 (seconds, rng) 를 받아 -1~1 범위의 float32 모노 배열을 돌려준다.
"""
import argparse
import os
import sys
import wave

import numpy as np

SR = 44100


# ---------------------------------------------------------------- 기본 재료
def t_axis(sec):
    return np.arange(int(sec * SR)) / SR


def env_exp(sec, decay):
    """지수 감쇠 엔벨로프. decay 가 클수록 빨리 사라진다."""
    return np.exp(-decay * t_axis(sec))


def env_adsr(n, a=0.01, d=0.1, s=0.7, r=0.2):
    a_n, d_n, r_n = int(a * SR), int(d * SR), int(r * SR)
    s_n = max(0, n - a_n - d_n - r_n)
    e = np.concatenate([
        np.linspace(0, 1, a_n, endpoint=False),
        np.linspace(1, s, d_n, endpoint=False),
        np.full(s_n, s),
        np.linspace(s, 0, r_n),
    ])
    return np.pad(e, (0, max(0, n - len(e))))[:n]


def noise(sec, rng):
    return rng.uniform(-1, 1, int(sec * SR))


def lowpass(x, cutoff):
    """1차 저역통과. cutoff 는 숫자 또는 샘플별 배열(스윕용)."""
    cutoff = np.broadcast_to(np.asarray(cutoff, dtype=float), x.shape)
    alpha = 1 - np.exp(-2 * np.pi * cutoff / SR)
    y = np.empty_like(x)
    acc = 0.0
    for i in range(len(x)):
        acc += alpha[i] * (x[i] - acc)
        y[i] = acc
    return y


def highpass(x, cutoff):
    return x - lowpass(x, cutoff)


def bandpass(x, lo, hi):
    return lowpass(highpass(x, lo), hi)


def sine_sweep(sec, f0, f1, curve="exp"):
    t = t_axis(sec)
    if curve == "exp":
        f = f0 * (f1 / f0) ** (t / sec)
    else:
        f = f0 + (f1 - f0) * t / sec
    phase = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(phase)


def reverb(x, rng, room=1.2, wet=0.3):
    """노이즈 기반 임펄스 응답으로 간단한 공간감을 준다."""
    ir = noise(room, rng) * env_exp(room, 6 / room)
    ir = lowpass(ir, 4000)
    ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
    n = len(x) + len(ir) - 1
    size = 1 << (n - 1).bit_length()
    y = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(ir, size), size)[:n]
    dry = np.pad(x, (0, n - len(x)))
    return (1 - wet) * dry + wet * y


def place(buf, clip, at_sec, gain=1.0):
    i = int(at_sec * SR)
    if i >= len(buf):
        return buf
    end = min(len(buf), i + len(clip))
    buf[i:end] += gain * clip[: end - i]
    return buf


def thump(freq=70, sec=0.25, decay=18, click=0.3, rng=None):
    body = sine_sweep(sec, freq * 1.8, freq) * env_exp(sec, decay)
    if rng is not None and click:
        body += click * lowpass(noise(sec, rng), 2500) * env_exp(sec, 60)
    return body


# ---------------------------------------------------------------- 효과음들
def footsteps(sec, rng):
    """어두운 복도를 걷는 구두 발소리."""
    sec = sec or 4.0
    out = np.zeros(int(sec * SR))
    t, step = 0.2, 0
    while t < sec - 0.3:
        heel = thump(90 + rng.uniform(-10, 10), 0.18, 25, 0.0)
        heel += 0.6 * bandpass(noise(0.18, rng), 800, 5000) * env_exp(0.18, 70)
        place(out, heel, t, 0.9 if step % 2 else 0.75)
        t += 0.55 + rng.uniform(-0.04, 0.04)
        step += 1
    return reverb(out, rng, 1.5, 0.35)


def door_slam(sec, rng):
    """묵직한 철문/나무문 닫힘."""
    sec = sec or 2.5
    out = np.zeros(int(sec * SR))
    place(out, 0.3 * bandpass(noise(0.12, rng), 300, 3000) * env_exp(0.12, 30), 0.0)
    hit = thump(55, 0.6, 9, 0.8, rng)
    place(out, hit, 0.1)
    place(out, 0.25 * bandpass(noise(0.3, rng), 1500, 6000) * env_exp(0.3, 25), 0.12)
    return reverb(out, rng, 2.0, 0.4)


def typewriter(sec, rng):
    """수사 보고서를 치는 타자기. 끝에 종소리."""
    sec = sec or 4.0
    out = np.zeros(int(sec * SR))
    t = 0.1
    while t < sec - 0.9:
        k = bandpass(noise(0.05, rng), 1500, 7000) * env_exp(0.05, 120)
        k += 0.5 * thump(180, 0.05, 80, 0.0)
        place(out, k, t, rng.uniform(0.6, 1.0))
        t += rng.choice([0.08, 0.11, 0.14, 0.3], p=[0.4, 0.35, 0.2, 0.05])
    bell = (np.sin(2 * np.pi * 2093 * t_axis(0.8)) + 0.4 * np.sin(2 * np.pi * 3140 * t_axis(0.8)))
    place(out, 0.35 * bell * env_exp(0.8, 6), sec - 0.85)
    return reverb(out, rng, 0.6, 0.15)


def heartbeat(sec, rng):
    """긴장감용 심장 박동 (lub-dub)."""
    sec = sec or 4.0
    out = np.zeros(int(sec * SR))
    t = 0.1
    while t < sec - 0.5:
        place(out, thump(45, 0.25, 16, 0.0), t, 1.0)
        place(out, thump(40, 0.22, 18, 0.0), t + 0.22, 0.7)
        t += 0.9
    return lowpass(out, 400)


def rain(sec, rng):
    """창밖 빗소리."""
    sec = sec or 8.0
    bed = lowpass(noise(sec, rng), 2500) * 0.35
    bed = highpass(bed, 200)
    for _ in range(int(sec * 40)):
        drop = bandpass(noise(0.03, rng), 2000, 8000) * env_exp(0.03, 150)
        place(bed, drop, rng.uniform(0, sec), rng.uniform(0.05, 0.25))
    fade = np.minimum(1, np.minimum(t_axis(sec), sec - t_axis(sec)) / 0.8)
    return bed * fade


def wind(sec, rng):
    """쓸쓸한 바람 소리."""
    sec = sec or 8.0
    t = t_axis(sec)
    sweep = 400 + 300 * np.sin(2 * np.pi * 0.15 * t) + 150 * np.sin(2 * np.pi * 0.37 * t + 1)
    x = lowpass(noise(sec, rng), sweep)
    x = lowpass(x, sweep * 1.5)
    fade = np.minimum(1, np.minimum(t, sec - t) / 1.5)
    return x * fade * 3


def camera_shutter(sec, rng):
    """옛 필름 카메라 셔터."""
    sec = sec or 0.6
    out = np.zeros(int(sec * SR))
    c = bandpass(noise(0.04, rng), 1000, 8000) * env_exp(0.04, 120)
    place(out, c, 0.02)
    place(out, 0.8 * c, 0.12)
    place(out, 0.3 * thump(300, 0.05, 90, 0.0), 0.12)
    return reverb(out, rng, 0.3, 0.1)


def phone_ring(sec, rng):
    """다이얼 전화기 벨 (두 번 울림)."""
    sec = sec or 4.0
    out = np.zeros(int(sec * SR))
    ring_len = 1.0
    t = t_axis(ring_len)
    tone = np.sin(2 * np.pi * 950 * t) + 0.6 * np.sin(2 * np.pi * 1400 * t)
    trem = 0.5 + 0.5 * np.sign(np.sin(2 * np.pi * 20 * t))
    ring = tone * trem * env_adsr(len(t), 0.01, 0.05, 0.9, 0.1)
    for start in (0.1, 0.1 + ring_len + 1.0):
        if start + ring_len < sec:
            place(out, 0.5 * ring, start)
    return reverb(out, rng, 0.8, 0.25)


def clock_tick(sec, rng):
    """벽시계 째깍 소리."""
    sec = sec or 5.0
    out = np.zeros(int(sec * SR))
    for i, t in enumerate(np.arange(0.1, sec - 0.1, 1.0)):
        f = 3200 if i % 2 else 2600
        tick = np.sin(2 * np.pi * f * t_axis(0.03)) * env_exp(0.03, 200)
        tick += 0.5 * bandpass(noise(0.03, rng), 2000, 6000) * env_exp(0.03, 250)
        place(out, tick, t, 0.6)
    return reverb(out, rng, 0.5, 0.2)


def whoosh(sec, rng):
    """장면 전환 휙 소리."""
    sec = sec or 1.2
    t = t_axis(sec)
    cutoff = 300 + 5000 * np.sin(np.pi * t / sec) ** 2
    x = lowpass(noise(sec, rng), cutoff)
    return x * np.sin(np.pi * t / sec) ** 2 * 2.5


def riser(sec, rng):
    """긴장이 올라가는 라이저."""
    sec = sec or 4.0
    t = t_axis(sec)
    grow = (t / sec) ** 2
    tone = sine_sweep(sec, 110, 880) + 0.5 * sine_sweep(sec, 165, 1320)
    hiss = lowpass(noise(sec, rng), 300 + 6000 * grow) * 0.6
    out = (0.4 * tone + hiss) * grow
    out[-int(0.03 * SR):] *= np.linspace(1, 0, int(0.03 * SR))
    return out


def impact(sec, rng):
    """영화식 '쿵' 임팩트 (타이틀, 결정적 순간)."""
    sec = sec or 4.0
    out = np.zeros(int(sec * SR))
    place(out, sine_sweep(2.5, 120, 30) * env_exp(2.5, 2.2), 0.0, 1.0)
    place(out, 0.5 * lowpass(noise(0.4, rng), 1500) * env_exp(0.4, 12), 0.0)
    return reverb(out, rng, 3.0, 0.35)


def film_projector(sec, rng):
    """옛날 영사기 돌아가는 소리 (회상 장면)."""
    sec = sec or 6.0
    out = np.zeros(int(sec * SR))
    for t in np.arange(0.0, sec, 1 / 24):
        c = bandpass(noise(0.02, rng), 800, 4000) * env_exp(0.02, 200)
        place(out, c, t, rng.uniform(0.3, 0.5))
    out += 0.08 * lowpass(noise(sec, rng), 600)
    fade = np.minimum(1, np.minimum(t_axis(sec), sec - t_axis(sec)) / 0.5)
    return out * fade


def vinyl_crackle(sec, rng):
    """LP 잡음 (옛 시절 분위기)."""
    sec = sec or 8.0
    out = 0.02 * lowpass(noise(sec, rng), 3000)
    for _ in range(int(sec * 25)):
        pop = highpass(noise(0.004, rng), 2000) * env_exp(0.004, 800)
        place(out, pop, rng.uniform(0, sec), rng.uniform(0.1, 0.6))
    return out


SOUNDS = {
    "footsteps": footsteps,
    "door_slam": door_slam,
    "typewriter": typewriter,
    "heartbeat": heartbeat,
    "rain": rain,
    "wind": wind,
    "camera_shutter": camera_shutter,
    "phone_ring": phone_ring,
    "clock_tick": clock_tick,
    "whoosh": whoosh,
    "riser": riser,
    "impact": impact,
    "film_projector": film_projector,
    "vinyl_crackle": vinyl_crackle,
}


# ---------------------------------------------------------------- 저장
def write_wav(path, x):
    x = np.asarray(x, dtype=np.float64)
    peak = np.max(np.abs(x)) or 1.0
    x = x / peak * 0.89  # 약 -1 dBFS
    pcm = (x * 32767).astype("<i2")
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_out = os.path.join(here, "..", "audio", "sfx")
    p = argparse.ArgumentParser(description="코드로 효과음 합성")
    p.add_argument("names", nargs="*", help="효과음 이름들 또는 all")
    p.add_argument("--out", default=default_out, help="출력 폴더 (기본: audio/sfx)")
    p.add_argument("--seconds", type=float, default=0, help="길이(초). 0이면 기본값")
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--list", action="store_true")
    a = p.parse_args()

    if a.list or not a.names:
        for name, fn in SOUNDS.items():
            print(f"{name:16s} {(fn.__doc__ or '').strip()}")
        return
    names = list(SOUNDS) if a.names == ["all"] else a.names
    unknown = [n for n in names if n not in SOUNDS]
    if unknown:
        sys.exit(f"모르는 효과음: {', '.join(unknown)}  (--list 로 확인)")
    for name in names:
        rng = np.random.default_rng(a.seed)
        x = SOUNDS[name](a.seconds, rng)
        path = os.path.join(a.out, f"{name}.wav")
        write_wav(path, x)
        print(f"생성: {os.path.normpath(path)}  ({len(x) / SR:.1f}s)")


if __name__ == "__main__":
    main()
