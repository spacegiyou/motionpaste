# MotionPaste 시작하기

**요소 선택 → 모션 캡처 → 다른 디자인에 적용 → 시간 변경 → JavaScript 출력**을 제공하는 로컬 Chrome 확장 베타입니다.

## 설치

1. [GitHub Release](https://github.com/spacegiyou/motionpaste/releases/tag/v0.1.0-beta.3)에서 `motionpaste-0.1.0-beta.3.zip`을 내려받아 압축을 풉니다.
2. Chrome의 `chrome://extensions`에서 **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램을 로드합니다**를 누르고 `manifest.json`이 들어 있는 폴더를 선택합니다.
4. 툴바에 MotionPaste를 고정합니다. ZIP 자체나 소스 저장소 폴더를 선택하는 방식은 아닙니다.

Chrome Web Store 배포는 아직 없습니다. 설치 최소 버전은 Chrome 120이며 실제 시험 환경은 [검증 기록](docs/VERIFICATION.md)에 구분했습니다.

## 처음 성공해 보기

저장소를 내려받고 **Node 22.13 이상의 22.x 또는 Node 24 이상**에서 실행합니다.

```sh
npm ci
npm run build
npm run dev
```

1. [로컬 원본 예제](http://127.0.0.1:4173/fixtures/source-app/)를 엽니다.
2. 툴바 아이콘 → **Capture motion** → 초록 카드를 선택합니다. Escape는 취소입니다.
3. 열리는 Studio에서 **Play motion**, Button / Card / Pill을 사용합니다.
4. Duration을 `733`으로 바꾸고 **Compare original timing**으로 비교합니다.
5. **Restore loaded duration**으로 로드한 값에 돌아갈 수 있습니다.
6. **JavaScript** 또는 **Recipe JSON**을 내려받습니다.

확장 캡처는 CAPTURED, 파일 가져오기는 IMPORTED, 수정은 EDITED입니다. 동작 줄이기 설정이 켜져 있으면 기본 재생을 막으며 **Play once anyway**로 이번 미리보기만 허용할 수 있습니다.

## 자신의 앱에서 실행

내려받은 JavaScript를 페이지에서 로드한 다음 호출합니다.

```js
const motion = window.motionPaste(document.querySelector('.my-button'));
// 필요할 때 이번 애니메이션만 정리합니다.
motion.cancel();
```

파일 자체에 검증·재생·정리 코드가 들어 있으므로 확장이나 외부 라이브러리가 필요하지 않습니다. 파일을 로드하기만 해서는 재생하지 않습니다.

## 범위와 오류

HTML 요소 하나의 단일 유한 CSS/WAAPI 효과와 명시적인 2D transform·opacity가 범위입니다. Transition, 복수 효과, 무한 반복, 3D, 상대 단위, Canvas·GSAP 추정은 지원하지 않습니다.

`CAPTURE blocked [코드]`는 원본에서 읽지 못한 경우, `APPLY blocked [코드]`는 대상에서 재생할 수 없는 경우입니다. 캡처 성공 뒤에도 대상의 읽기 불가 CSS, `!important`, 기존 애니메이션 때문에 거부될 수 있습니다. 원본 디자인·부모 문맥·모든 CSS 우선순위를 재구성하지 않습니다.

[15초 영상](docs/assets/MotionPaste-promo.mp4) · [35초 영상](docs/assets/MotionPaste-demo.mp4) · [검증·검토 범위](docs/VERIFICATION.md) · [보안 정책](SECURITY.md)
