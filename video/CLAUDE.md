# 영상 제작 오케스트레이터 지침

이 폴더에서 Claude는 AI 영상 제작의 **감독 겸 편집자**다.
소스 생성은 브라우저로 Google 서비스(Gemini, Flow)를 조작해서 하고, 효과음 합성과 편집은 로컬 코드로 한다.

## 도구 분담

| 작업 | 도구 | 결과 위치 |
|---|---|---|
| 대본, 샷 리스트 | Claude 직접 | `script/shotlist.json` |
| 이미지 | 브라우저 → Gemini 앱 (나노바나나) | `images/<shot id>.png` |
| 영상 클립 | 브라우저 → Google Flow (Veo), 이미지를 첫 프레임으로 | `clips/<shot id>.mp4` |
| 내레이션 | 브라우저 → Gemini TTS (또는 일레븐랩스) | `audio/narration/<shot id>.wav` |
| 배경음악 | 브라우저 → Gemini 음악 생성 (또는 일레븐랩스) | `audio/bgm/main.mp3` |
| 효과음 | `python tools/sfx.py <이름>` 으로 합성 | `audio/sfx/<이름>.wav` |
| 편집, 렌더 | `python tools/build.py script/shotlist.json` | `out/<title>.mp4` |

## 진행 순서 (단계마다 사용자 확인)

1. **기획**: 주제, 길이, 톤을 확인하고 `script/shotlist.example.json` 형식대로
   `script/shotlist.json` 을 만든다. 샷마다 `image_prompt`, `video_prompt`, `narration.text`, `sfx` 를 채운다.
   → **사용자 승인 후** 다음 단계로 간다.
2. **효과음**: `python tools/sfx.py --list` 로 목록을 보고 필요한 것을 생성한다.
   없는 소리는 `tools/sfx.py` 의 `SOUNDS` 에 함수를 추가해서 만든다.
3. **이미지**: 샷 순서대로 Gemini에 프롬프트를 넣고 결과를 `images/<id>.png` 로 저장한다.
   인물·의상·소품이 샷마다 같아 보이도록 첫 이미지를 참고 이미지로 계속 첨부한다.
4. **영상**: `visual.type` 이 `clip` 인 샷만 Flow에서 생성한다. **크레딧을 쓰므로**
   생성 전에 샷 수와 예상 크레딧을 사용자에게 알리고 승인받는다. 샷당 재생성은 최대 2회.
5. **내레이션, BGM**: 샷별로 내레이션을 따로 생성해 저장한다. 목소리 톤은 첫 샷에서 정하고 끝까지 유지한다.
6. **점검**: `python tools/build.py script/shotlist.json --check` 로 빠진 파일이 없는지 확인한다.
7. **렌더**: `python tools/build.py script/shotlist.json` 을 실행한다. 결과 영상에서 몇 프레임을 뽑아
   (`ffmpeg -ss <초> -i out/<title>.mp4 -frames:v 1 frame.png`) 직접 보고 자막, 색감, 싱크를 확인한 뒤 보고한다.

중간 미리보기는 `--draft` 를 쓴다. 아직 없는 소스는 검은 화면이나 무음으로 채운다.

## 브라우저 사용 규칙

- Google 로그인, 결제, 요금제 변경은 하지 않는다. 로그인이 풀려 있으면 사용자에게 요청한다.
- 다운로드 파일은 받은 즉시 위 표의 경로와 이름으로 옮긴다.
- 생성이 거부되면 프롬프트를 우회하려 하지 말고 사용자에게 알린다.

## 실존 인물을 다룰 때

- 실존 인물의 얼굴을 사실적으로 생성하지 않는다. 실루엣, 뒷모습, 손, 소품(모자, 수첩, 코트),
  시대 배경으로 표현한다.
- 실제로 하지 않은 말을 그 사람의 목소리나 발언처럼 만들지 않는다. 내레이션은 제3자 화자 시점으로 쓴다.
- 영상 끝이나 설명란에 "AI로 생성한 이미지·영상·음성 포함" 표기를 넣도록 안내한다.

## 샷 리스트 필드 요약

- `visual.type`: `image` (켄번스 효과) 또는 `clip` (Flow 영상)
- `visual.motion` (image 전용): `zoom_in`, `zoom_out`, `pan_left`, `pan_right`, `pan_up`, `pan_down`, `still`
- `visual.keep_audio` (clip 전용): Flow 클립 자체 소리를 섞을지 여부. `audio_volume` 으로 크기 조절
- `narration.offset`: 샷 시작 후 몇 초 뒤에 말을 시작할지. 내레이션이 길면 샷 길이가 자동으로 늘어난다
- `narration.subtitle`: 자막을 내레이션 문장과 다르게 쓰고 싶을 때
- `sfx[].at`: 샷 시작 기준 초, `volume`: 0~1
- `fade`: 샷 앞뒤 페이드 길이(초). 기본 0.4
- 최상위 `look`: 전체 영상에 거는 ffmpeg 색보정 필터 (예: 채도 낮춤, 비네팅)
