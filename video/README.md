# AI 영상 제작 키트

Claude(Opus 5.5)가 감독을 맡고 Google AI Pro(제미나이 프로, 월 약 3만 원)로 소스를 만드는 영상 제작 템플릿입니다.

- 이미지: 나노바나나 (Gemini 앱)
- 영상: Google Flow (Veo)
- 내레이션, BGM: Gemini (일레븐랩스가 있으면 그걸 써도 됩니다)
- 효과음: Claude가 코드로 합성 (`tools/sfx.py`)
- 편집: Claude가 ffmpeg로 처리 (`tools/build.py`)

## 1. 준비물

| 항목 | 내용 |
|---|---|
| Claude 유료 플랜 | Pro 또는 Max. 긴 작업이라 Max 권장 |
| Google AI Pro | Gemini 앱, Flow 크레딧 포함 |
| Claude 실행 환경 | **내 PC**의 Claude 데스크톱 앱 또는 Claude Code. 브라우저를 직접 조작해야 해서 클라우드 세션보다 로컬이 맞습니다 |
| 브라우저 조작 | 셋 중 하나: Aside 브라우저 / Claude in Chrome 확장 / 데스크톱 앱 내장 브라우저 |

## 2. 설치

```bash
# macOS
brew install ffmpeg python git
# Windows: winget install Gyan.FFmpeg Python.Python.3.12 Git.Git

git clone https://github.com/gigasam1/giga001.git
cd giga001/video
pip install -r requirements.txt
```

Claude Code를 쓴다면:

```bash
npm install -g @anthropic-ai/claude-code
cd giga001/video
claude
```

`video/CLAUDE.md`에 작업 지침이 들어 있어서, 이 폴더에서 Claude를 실행하면 순서와 규칙을 자동으로 따릅니다.

## 3. 브라우저 로그인 (사람이 먼저)

사용할 브라우저에서 아래 두 곳에 **직접 로그인**해 두세요. Claude는 로그인이나 결제를 대신하지 않습니다.

- https://gemini.google.com
- https://labs.google/flow

다운로드 폴더 위치도 확인해 두면 Claude가 파일을 옮길 때 헤매지 않습니다.

## 4. 시작하기

Claude에게 이렇게 말하면 됩니다.

> video 폴더에서 작업해. ○○을 주제로 2분짜리 추모 영상을 만들 거야.
> 분위기는 70년대 필름 느낌, 내레이션은 차분한 남성 목소리.
> 먼저 샷 리스트를 만들어서 보여줘.

이후 진행:

1. 샷 리스트 확인 → 승인
2. Claude가 효과음 합성 → 이미지 생성 → (승인 후) Flow 영상 생성 → 내레이션, BGM 생성
3. `--check`로 빠진 파일 점검
4. 최종 렌더 → `out/` 폴더에서 확인

## 5. 도구만 따로 쓰기

```bash
# 효과음
python tools/sfx.py --list                 # 목록
python tools/sfx.py all                    # 전부 생성 → audio/sfx/
python tools/sfx.py rain --seconds 12      # 길이 지정

# 편집
python tools/build.py script/shotlist.json --check   # 빠진 파일 점검
python tools/build.py script/shotlist.json --draft   # 빠진 건 검은 화면으로 채운 미리보기
python tools/build.py script/shotlist.json           # 최종 렌더
python tools/build.py script/shotlist.json --no-burn # 자막을 화면에 굽지 않고 별도 트랙으로
```

합성할 수 있는 효과음: 발소리, 문 닫힘, 타자기, 심장 박동, 비, 바람, 카메라 셔터, 다이얼 전화벨, 시계 초침, 휙(전환), 라이저, 임팩트, 영사기, LP 잡음.

`build.py`가 처리하는 것:

- 이미지에 줌/팬 효과(켄번스)를 넣고, Flow 클립은 1080p로 맞춤
- 내레이션 길이에 맞춰 샷 길이를 자동으로 늘림
- 내레이션이 나올 때 BGM 음량을 자동으로 낮춤(덕킹)
- 효과음을 지정한 시각에 배치하고 유튜브 기준 음량(-16 LUFS)으로 맞춤
- 내레이션으로 자막(SRT)을 만들어 영상에 입힘

## 폴더 구조

```
video/
  CLAUDE.md                     Claude 작업 지침
  script/shotlist.example.json  샷 리스트 예시 (복사해서 shotlist.json으로)
  tools/sfx.py                  효과음 합성
  tools/build.py                편집, 렌더
  images/  clips/               나노바나나, Flow 결과
  audio/narration/ bgm/ sfx/    오디오
  out/                          완성본
```

생성한 미디어 파일은 용량이 커서 `.gitignore`로 git에서 빠져 있습니다.

## 주의

- **실존 인물**: Flow와 나노바나나는 실존 인물의 얼굴 생성을 거부하거나 제한할 수 있습니다. 실루엣, 뒷모습, 소품 위주로 연출하고, 영상에 "AI 생성" 표기를 넣으세요.
- **크레딧**: Flow 크레딧은 한도가 있습니다. Claude는 영상 생성 전에 샷 수를 알리고 승인을 받도록 되어 있습니다.
- **자막 폰트**: 기본값은 `Noto Sans CJK KR`입니다. 없으면 `shotlist.json`의 `subtitle_font`를 `Apple SD Gothic Neo`(macOS)나 `Malgun Gothic`(Windows)으로 바꾸세요.
