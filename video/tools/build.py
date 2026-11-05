#!/usr/bin/env python3
"""샷 리스트(JSON)를 읽어 ffmpeg 로 최종 영상을 만든다.

사용법:
    python tools/build.py script/shotlist.json            # 빌드
    python tools/build.py script/shotlist.json --check    # 빠진 파일만 점검
    python tools/build.py script/shotlist.json --draft    # 빠진 소스는 검은 화면으로 대체해 미리보기

하는 일:
  1. 샷마다 이미지(켄번스 줌/팬) 또는 Flow 클립을 1080p 로 맞춰 세그먼트를 만든다.
     내레이션 파일이 있으면 그 길이에 맞춰 샷 길이를 자동으로 늘린다.
  2. 세그먼트를 이어 붙인다 (샷 경계는 짧은 페이드).
  3. 내레이션 + 효과음을 정해진 시각에 배치하고, BGM 은 내레이션이 나올 때 자동으로 줄인다(덕킹).
  4. 자막(SRT)을 만들어 영상에 입히고 out/ 에 저장한다.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))


def run(cmd):
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0:
        print(" ".join(cmd), file=sys.stderr)
        print(r.stderr[-3000:], file=sys.stderr)
        sys.exit(f"ffmpeg 실패 (코드 {r.returncode})")
    return r.stdout


def duration_of(path):
    out = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
               "-of", "default=nw=1:nk=1", path])
    return float(out.strip())


def has_audio_stream(path):
    out = run(["ffprobe", "-v", "error", "-select_streams", "a",
               "-show_entries", "stream=index", "-of", "csv=p=0", path])
    return bool(out.strip())


def resolve(p):
    return p if os.path.isabs(p) else os.path.join(ROOT, p)


def srt_time(sec):
    ms = int(round(sec * 1000))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


# ---------------------------------------------------------------- 점검
def check(spec):
    missing = []
    for sh in spec["shots"]:
        v = sh.get("visual", {})
        if v.get("file") and not os.path.exists(resolve(v["file"])):
            missing.append((sh["id"], "visual", v["file"]))
        n = sh.get("narration") or {}
        if n.get("file") and not os.path.exists(resolve(n["file"])):
            missing.append((sh["id"], "narration", n["file"]))
        for fx in sh.get("sfx", []):
            if not os.path.exists(resolve(fx["file"])):
                missing.append((sh["id"], "sfx", fx["file"]))
    bgm = spec.get("bgm") or {}
    if bgm.get("file") and not os.path.exists(resolve(bgm["file"])):
        missing.append(("-", "bgm", bgm["file"]))
    return missing


# ---------------------------------------------------------------- 영상
MOTIONS = {
    # zoompan 식: z=줌, x/y=좌상단 좌표. on=출력 프레임 번호, d=총 프레임
    "zoom_in":   ("min(1+0.12*on/{d},1.12)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
    "zoom_out":  ("max(1.12-0.12*on/{d},1)", "iw/2-(iw/zoom/2)", "ih/2-(ih/zoom/2)"),
    "pan_left":  ("1.1", "(iw-iw/zoom)*(1-on/{d})", "ih/2-(ih/zoom/2)"),
    "pan_right": ("1.1", "(iw-iw/zoom)*on/{d}", "ih/2-(ih/zoom/2)"),
    "pan_up":    ("1.1", "iw/2-(iw/zoom/2)", "(ih-ih/zoom)*(1-on/{d})"),
    "pan_down":  ("1.1", "iw/2-(iw/zoom/2)", "(ih-ih/zoom)*on/{d}"),
    "still":     ("1", "0", "0"),
}


def make_segment(sh, dur, W, H, fps, out, draft, look):
    v = sh.get("visual", {})
    src = resolve(v["file"]) if v.get("file") else None
    fade = float(sh.get("fade", 0.4))
    post = []
    if look:
        post.append(look)
    if fade > 0:
        post.append(f"fade=t=in:st=0:d={fade}")
        post.append(f"fade=t=out:st={max(0, dur - fade):.3f}:d={fade}")
    post.append("format=yuv420p")
    tail = ",".join(post)
    enc = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-r", str(fps), "-an"]

    if not src or not os.path.exists(src):
        if not draft:
            sys.exit(f"[{sh['id']}] 소스 없음: {v.get('file')}  (--draft 로 미리보기 가능)")
        run(["ffmpeg", "-y", "-f", "lavfi", "-i", f"color=c=0x111111:s={W}x{H}:r={fps}:d={dur}",
             "-vf", tail, *enc, out])
        return

    if v.get("type", "image") == "image":
        frames = int(round(dur * fps))
        z, x, y = (e.format(d=frames) for e in MOTIONS[v.get("motion", "zoom_in")])
        # 먼저 크게 키워 놓고 줌/팬 해야 계단 현상이 적다
        vf = (f"scale={W * 2}:{H * 2}:force_original_aspect_ratio=increase,"
              f"crop={W * 2}:{H * 2},"
              f"zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={W}x{H}:fps={fps},{tail}")
        run(["ffmpeg", "-y", "-loop", "1", "-i", src, "-vf", vf, "-t", f"{dur:.3f}", *enc, out])
    else:
        start = float(v.get("start", 0))
        speed = float(v.get("speed", 1.0))
        vf = (f"setpts=PTS/{speed},"
              f"scale={W}:{H}:force_original_aspect_ratio=decrease,"
              f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps={fps},"
              f"tpad=stop_mode=clone:stop_duration={dur},{tail}")
        run(["ffmpeg", "-y", "-ss", str(start), "-i", src, "-vf", vf, "-t", f"{dur:.3f}", *enc, out])


# ---------------------------------------------------------------- 오디오
def build_audio(spec, timeline, total, out, draft):
    inputs, voice, fx = [], [], []

    def add_input(path):
        inputs.extend(["-i", path])
        return len(inputs) // 2 - 1

    for sh, t0, _dur in timeline:
        n = sh.get("narration") or {}
        if n.get("file") and os.path.exists(resolve(n["file"])):
            i = add_input(resolve(n["file"]))
            ms = int((t0 + float(n.get("offset", 0.5))) * 1000)
            vol = float(n.get("volume", 1.0))
            voice.append(f"[{i}:a]aformat=sample_rates=48000:channel_layouts=stereo,"
                         f"volume={vol},adelay={ms}|{ms}[v{i}]")
        for k, s in enumerate(sh.get("sfx", [])):
            p = resolve(s["file"])
            if not os.path.exists(p):
                continue
            i = add_input(p)
            ms = int((t0 + float(s.get("at", 0))) * 1000)
            vol = float(s.get("volume", 0.7))
            fx.append(f"[{i}:a]aformat=sample_rates=48000:channel_layouts=stereo,"
                      f"volume={vol},adelay={ms}|{ms}[f{i}]")
        # Flow 클립 자체 소리를 쓰고 싶으면 visual.keep_audio=true
        v = sh.get("visual", {})
        if v.get("keep_audio") and v.get("file") and os.path.exists(resolve(v["file"])) \
                and has_audio_stream(resolve(v["file"])):
            i = add_input(resolve(v["file"]))
            ms = int(t0 * 1000)
            fx.append(f"[{i}:a]aformat=sample_rates=48000:channel_layouts=stereo,"
                      f"atrim=0:{_dur},volume={float(v.get('audio_volume', 0.5))},"
                      f"adelay={ms}|{ms}[f{i}]")

    graph = []
    silence = f"anullsrc=r=48000:cl=stereo,atrim=0:{total}"
    graph.append(f"{silence}[sil]")
    labels_v = [g.rsplit("[", 1)[1][:-1] for g in voice]
    labels_f = [g.rsplit("[", 1)[1][:-1] for g in fx]
    graph += voice + fx

    # 내레이션 버스
    if labels_v:
        graph.append("".join(f"[{l}]" for l in labels_v) + "[sil]"
                     + f"amix=inputs={len(labels_v) + 1}:normalize=0:duration=longest,"
                     + f"atrim=0:{total}[voice]")
    else:
        graph.append("[sil]anull[voice]")

    bgm = spec.get("bgm") or {}
    bgm_path = resolve(bgm["file"]) if bgm.get("file") else None
    mix_parts = []
    if bgm_path and os.path.exists(bgm_path):
        inputs[:0] = ["-stream_loop", "-1", "-i", bgm_path]
        # 앞에 BGM 입력을 끼웠으니 다른 입력 번호를 1씩 민다
        graph = [_shift_inputs(g) for g in graph]
        vol = float(bgm.get("volume", 0.25))
        fi, fo = float(bgm.get("fade_in", 2)), float(bgm.get("fade_out", 3))
        graph.append(f"[0:a]aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:{total},"
                     f"volume={vol},afade=t=in:d={fi},afade=t=out:st={max(0, total - fo)}:d={fo}[bgm0]")
        if bgm.get("duck", True) and labels_v:
            graph.append("[voice]asplit=2[voice_a][voice_sc]")
            graph.append("[bgm0][voice_sc]sidechaincompress=threshold=0.03:ratio=8:"
                         "attack=20:release=400[bgm]")
            mix_parts += ["[voice_a]", "[bgm]"]
        else:
            mix_parts += ["[voice]", "[bgm0]"]
    else:
        if bgm_path and not draft:
            print(f"경고: BGM 없음 ({bgm['file']}), BGM 없이 진행", file=sys.stderr)
        mix_parts.append("[voice]")

    mix_parts += [f"[{l}]" for l in labels_f]
    graph.append("".join(mix_parts) + f"amix=inputs={len(mix_parts)}:normalize=0:duration=first,"
                 f"atrim=0:{total},alimiter=limit=0.9,"
                 f"loudnorm=I=-16:TP=-1.5:LRA=11[aout]")

    run(["ffmpeg", "-y", *inputs, "-filter_complex", ";".join(graph),
         "-map", "[aout]", "-c:a", "pcm_s16le", "-ar", "48000", out])


def _shift_inputs(g):
    import re
    return re.sub(r"\[(\d+):a\]", lambda m: f"[{int(m.group(1)) + 1}:a]", g)


# ---------------------------------------------------------------- 메인
def main():
    p = argparse.ArgumentParser(description="샷 리스트 → 최종 영상")
    p.add_argument("shotlist")
    p.add_argument("--check", action="store_true", help="빠진 파일만 점검")
    p.add_argument("--draft", action="store_true", help="빠진 소스는 검은 화면/무음으로 대체")
    p.add_argument("--out", help="출력 파일 (기본: out/<title>.mp4)")
    p.add_argument("--no-burn", action="store_true", help="자막을 화면에 굽지 않고 별도 트랙으로")
    a = p.parse_args()

    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} 이 설치되어 있지 않습니다. (macOS: brew install ffmpeg)")

    with open(a.shotlist, encoding="utf-8") as f:
        spec = json.load(f)

    missing = check(spec)
    if missing:
        print("빠진 파일:")
        for sid, kind, path in missing:
            print(f"  [{sid}] {kind:9s} {path}")
    if a.check:
        print("모두 준비됨" if not missing else f"\n총 {len(missing)}개 빠짐")
        sys.exit(1 if missing else 0)

    W, H = spec.get("resolution", [1920, 1080])
    fps = int(spec.get("fps", 30))
    look = spec.get("look", "")
    build = os.path.join(ROOT, "out", "build")
    os.makedirs(build, exist_ok=True)

    # 1) 타임라인 계산 (내레이션 길이에 맞춰 자동 연장)
    timeline, t = [], 0.0
    for sh in spec["shots"]:
        dur = float(sh.get("duration", 5))
        n = sh.get("narration") or {}
        if n.get("file") and os.path.exists(resolve(n["file"])):
            need = float(n.get("offset", 0.5)) + duration_of(resolve(n["file"])) + float(n.get("tail", 0.6))
            if need > dur:
                print(f"[{sh['id']}] 내레이션에 맞춰 {dur:.1f}s → {need:.1f}s")
                dur = need
        timeline.append((sh, t, dur))
        t += dur
    total = t
    print(f"총 길이 {total:.1f}s, 샷 {len(timeline)}개")

    # 2) 세그먼트
    segs = []
    for sh, _t0, dur in timeline:
        out = os.path.join(build, f"{sh['id']}.mp4")
        print(f"  영상 {sh['id']} ({dur:.1f}s)")
        make_segment(sh, dur, W, H, fps, out, a.draft, look)
        segs.append(out)
    concat_list = os.path.join(build, "concat.txt")
    with open(concat_list, "w") as f:
        f.writelines(f"file '{s}'\n" for s in segs)
    video = os.path.join(build, "video.mp4")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_list, "-c", "copy", video])

    # 3) 오디오
    print("  오디오 믹싱")
    audio = os.path.join(build, "mix.wav")
    build_audio(spec, timeline, total, audio, a.draft)

    # 4) 자막
    srt = os.path.join(build, "subs.srt")
    with open(srt, "w", encoding="utf-8") as f:
        idx = 1
        for sh, t0, dur in timeline:
            n = sh.get("narration") or {}
            text = n.get("subtitle", n.get("text"))
            if not text or not spec.get("subtitles", True):
                continue
            st = t0 + float(n.get("offset", 0.5))
            f.write(f"{idx}\n{srt_time(st)} --> {srt_time(t0 + dur - 0.2)}\n{text}\n\n")
            idx += 1

    # 5) 합치기
    title = spec.get("title", "final")
    final = a.out or os.path.join(ROOT, "out", f"{title}.mp4")
    font = spec.get("subtitle_font", "Noto Sans CJK KR")
    style = (f"FontName={font},FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H80000000,"
             f"BorderStyle=1,Outline=2,Shadow=0,MarginV=60")
    has_subs = os.path.getsize(srt) > 0
    if has_subs and not a.no_burn:
        esc = srt.replace("\\", "/").replace(":", "\\:").replace("'", "\\'")
        run(["ffmpeg", "-y", "-i", video, "-i", audio,
             "-vf", f"subtitles='{esc}':force_style='{style}'",
             "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", final])
    else:
        extra = ["-i", srt, "-c:s", "mov_text", "-metadata:s:s:0", "language=kor"] if has_subs else []
        run(["ffmpeg", "-y", "-i", video, "-i", audio, *extra[:2],
             "-map", "0:v", "-map", "1:a", *(["-map", "2:s"] if has_subs else []),
             "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", *extra[2:],
             "-shortest", "-movflags", "+faststart", final])
    shutil.copy(srt, os.path.splitext(final)[0] + ".srt")
    print(f"\n완성: {os.path.relpath(final, os.getcwd())}  ({duration_of(final):.1f}s)")


if __name__ == "__main__":
    main()
