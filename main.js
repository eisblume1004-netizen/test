import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// ======================
// scene
// ======================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000000);

// ======================
// camera（飛び出し強め）
// near を小さくして、かなり近くまで来ても消えないようにする
// ======================
const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.01,
  1000
);
camera.position.set(0, 1, 14);

// ======================
// renderer
// ======================
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);

// ======================
// 赤緑アナグリフ（自作の設定に合わせて自前実装）
// ======================
// three.jsのAnaglyphEffectは「赤・シアン(青緑)」の組み合わせ用に
// 色変換が最適化されているため、赤緑フィルムだとそのままでは使えない。
// なので、左目用・右目用の映像をそれぞれ描画してから、
// 赤チャンネル・緑チャンネルに直接割り当てる方式にする。

// ---- 重要：どちらの目に赤フィルムを貼ったか ----
// "left"  = 左目が赤、右目が緑 ←テスト画像で確認した結果、こちらが正解
// "right" = 右目が赤、左目が緑
// もし飛び出るはずが逆に引っ込んで見える・違和感がある場合は、
// 左右を間違えている可能性が高いので、ここを反対の値に変えてみてください。
const RED_EYE = "left";

const stereo = new THREE.StereoCamera();
stereo.aspect = camera.aspect;
stereo.eyeSep = 0.1; // 視差の強さ
camera.focus = 12;   // ゼロ視差面(world z = 14-12 = 2)。この位置より手前に来ると飛び出して見える

// 左目・右目の映像を一旦描き込むためのレンダーターゲット
const rtLeft = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight);
const rtRight = new THREE.WebGLRenderTarget(window.innerWidth, window.innerHeight);

// 赤緑合成用のフルスクリーンシェーダー
const composeScene = new THREE.Scene();
const composeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const composeMaterial = new THREE.ShaderMaterial({
  uniforms: {
    tRedEye: { value: null },   // 赤フィルム側の目に見せる映像
    tGreenEye: { value: null }, // 緑フィルム側の目に見せる映像
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: `
    varying vec2 vUv;
    uniform sampler2D tRedEye;
    uniform sampler2D tGreenEye;
    void main() {
      vec3 redEyeColor = texture2D(tRedEye, vUv).rgb;
      vec3 greenEyeColor = texture2D(tGreenEye, vUv).rgb;
      // 色そのものではなく明るさ(輝度)に変換してから
      // 赤チャンネル・緑チャンネルに割り当てる。
      // （青系オブジェクトはR,Gの生の値が低く暗くなりがちなので、
      //   輝度ベースにすることで見えやすくする）
      float redLum = dot(redEyeColor, vec3(0.299, 0.587, 0.114));
      float greenLum = dot(greenEyeColor, vec3(0.299, 0.587, 0.114));
      gl_FragColor = vec4(redLum, greenLum, 0.0, 1.0);
    }
  `
});
composeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), composeMaterial));

// ======================
// light（宝石見えるように）
// ======================
scene.add(new THREE.AmbientLight(0xffffff, 1.2));
const light1 = new THREE.PointLight(0xffffff, 2);
light1.position.set(5, 5, 5);
scene.add(light1);
const light2 = new THREE.PointLight(0xffffff, 1.5);
light2.position.set(-5, 3, 5);
scene.add(light2);

// ======================
// GLB
// ======================
const loader = new GLTFLoader();
let gem;
// フェードイン・フェードアウトのために、生成したマテリアルへの参照を保持しておく
const gemMaterials = [];
const wireMaterials = [];

// ======================
// ターゲットスコープ（マウス追従＋当たり判定）
// ======================
const scopeEl = document.getElementById("scope");
let mouseX = window.innerWidth / 2;
let mouseY = window.innerHeight / 2;

window.addEventListener("mousemove", (e) => {
  mouseX = e.clientX;
  mouseY = e.clientY;
  scopeEl.style.transform = `translate(-50%, -50%) translate(${mouseX}px, ${mouseY}px)`;
});

// 宝石の現在のワールド座標上での半径（毎フレームanimate()内で更新する）
let currentGemWorldRadius = 0;

// 3Dのワールド座標を画面上のピクセル座標に変換するヘルパー
function worldToScreen(vector3, cam) {
  const v = vector3.clone().project(cam); // NDC(-1〜1)に変換
  return {
    x: (v.x * 0.5 + 0.5) * window.innerWidth,
    y: (-v.y * 0.5 + 0.5) * window.innerHeight
  };
}

// クリックした瞬間、スコープ(=クリック位置)と宝石が画面上で重なっているか判定
renderer.domElement.addEventListener("click", () => {
  if (gameState !== "playing") return; // タイトル画面/結果画面中は判定しない
  if (!gem) return;

  const gemScreen = worldToScreen(gem.position, camera);

  // 宝石の見た目上の半径を求めるため、中心から半径分ずらした点も画面座標に変換する
  const edgeWorld = gem.position.clone().add(new THREE.Vector3(currentGemWorldRadius, 0, 0));
  const edgeScreen = worldToScreen(edgeWorld, camera);
  const hitRadiusPx = Math.hypot(edgeScreen.x - gemScreen.x, edgeScreen.y - gemScreen.y);

  const dx = mouseX - gemScreen.x;
  const dy = mouseY - gemScreen.y;
  const distPx = Math.hypot(dx, dy);

  if (distPx <= hitRadiusPx) {
    registerHit(mouseX, mouseY);
  } else {
    registerMiss(mouseX, mouseY);
  }
});

// ======================
// ゲーム進行管理（タイトル → プレイ中 → 結果）
// ======================
const GAME_DURATION = 60; // 秒
let gameState = "title"; // "title" | "playing" | "result"
let score = 0;
let timeLeft = GAME_DURATION;
let timerIntervalId = null;

const titleScreenEl = document.getElementById("title-screen");
const resultScreenEl = document.getElementById("result-screen");
const startButtonEl = document.getElementById("start-button");
const retryButtonEl = document.getElementById("retry-button");
const hudScoreEl = document.getElementById("hud-score");
const hudTimeEl = document.getElementById("hud-time");
const resultScoreEl = document.getElementById("result-score");

function updateHud() {
  hudScoreEl.textContent = `SCORE: ${score}`;
  hudTimeEl.textContent = `TIME: ${timeLeft}`;
}

function startGame() {
  score = 0;
  timeLeft = GAME_DURATION;
  updateHud();
  gameState = "playing";
  titleScreenEl.classList.add("hidden");
  resultScreenEl.classList.add("hidden");

  clearInterval(timerIntervalId);
  timerIntervalId = setInterval(() => {
    timeLeft -= 1;
    updateHud();
    if (timeLeft <= 0) {
      endGame();
    }
  }, 1000);
}

function endGame() {
  gameState = "result";
  clearInterval(timerIntervalId);
  resultScoreEl.textContent = `SCORE: ${score}`;
  resultScreenEl.classList.remove("hidden");
}

startButtonEl.addEventListener("click", startGame);
retryButtonEl.addEventListener("click", startGame);

// 命中/ミス時に画面にふわっと出す文字演出
function spawnFloatText(x, y, text, className) {
  const el = document.createElement("div");
  el.className = `float-text ${className}`;
  el.textContent = text;
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  document.body.appendChild(el);
  el.addEventListener("animationend", () => el.remove());
}

function registerHit(x, y) {
  score += 10;
  updateHud();
  spawnFloatText(x, y, "+10 HIT!", "hit");
  // ---- 命中時の演出 ----
  scopeEl.style.filter = "drop-shadow(0 0 12px red) brightness(1.5)";
  setTimeout(() => { scopeEl.style.filter = ""; }, 150);
  // 命中した宝石は奥へ戻す（撃ち落とした扱い）
  gem.position.z = START_Z;
}

function registerMiss(x, y) {
  spawnFloatText(x, y, "MISS", "miss");
}



// ---- 飛び出しの距離設定 ----
// START_Z: スタート地点（奥）
// END_Z  : カメラのすぐ手前まで迫る地点（ここまで来て初めてリセット）
// CAMERA_Z: カメラのz座標（近づき具合の計算に使用）
const START_Z = -18;
// END_Z, MAX_SCALE_FACTORはモデル読み込み後、実サイズを見て自動的に
// 安全な範囲に補正するので let にしておく
let END_Z = 6;
const CAMERA_Z = camera.position.z;
const BASE_SCALE = 3.5;
const MIN_SCALE_FACTOR = 0.7;
let MAX_SCALE_FACTOR = 2.8;
// カメラと宝石の表面との間に、最低限これだけの距離を残す(安全マージン)
const CAMERA_SAFETY_MARGIN = 3;
// 宝石の「スケール1のときの半径」。モデル読み込み後にloader.load内で設定される
let unitRadius = 1;

// ---- フェードイン/フェードアウト設定 ----
// 進行度(progress)の最初と最後、それぞれこの割合の区間で不透明度を0まで下げる
const FADE_RANGE = 0.12;
const BASE_GEM_OPACITY = 0.85;
const BASE_WIRE_OPACITY = 0.25;

loader.load("./models/diamond.glb", (gltf) => {
  gem = gltf.scene;
  gem.scale.set(2.8, 2.8, 2.8);
  // 中心補正
  const box = new THREE.Box3().setFromObject(gem);
  const center = box.getCenter(new THREE.Vector3());
  gem.position.sub(center);
  gem.position.set(0, 0, START_Z);

  // ---- ここが今回の肝：モデルの実サイズから安全なスケール上限を自動計算 ----
  // box は scale=2.8 の状態で計測したものなので、2.8で割って
  // 「スケール1のときの半径」を出す
  const size = box.getSize(new THREE.Vector3());
  unitRadius = Math.max(size.x, size.y, size.z) / 2 / 2.8;

  // 最接近時(END_Z)にカメラと宝石表面の間に安全マージンを残せる、
  // 最大の「スケール倍率(BASE_SCALE * MAX_SCALE_FACTOR)」を逆算する
  const closestDistance = CAMERA_Z - END_Z;
  const maxAllowedMultiplier = (closestDistance - CAMERA_SAFETY_MARGIN) / unitRadius;
  const requestedMultiplier = BASE_SCALE * MAX_SCALE_FACTOR;

  if (requestedMultiplier > maxAllowedMultiplier) {
    // 今設定している大きさだとカメラに宝石が被ってしまうので、
    // MAX_SCALE_FACTORを安全な値まで自動的に引き下げる
    MAX_SCALE_FACTOR = Math.max(MIN_SCALE_FACTOR, maxAllowedMultiplier / BASE_SCALE);
    console.warn(
      `[安全補正] MAX_SCALE_FACTORが大きすぎてカメラが宝石に埋もれるため、` +
      `自動的に ${MAX_SCALE_FACTOR.toFixed(2)} まで引き下げました。` +
      `（宝石のunitRadius=${unitRadius.toFixed(2)}）`
    );
  }

  gem.traverse((child) => {
    if (child.isMesh) {
      // ======================
      // サファイア材質
      // ======================
      child.material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(0x2b6cff),
        transparent: true,
        opacity: 0.85,
        metalness: 0.2,
        roughness: 0.05,
        emissive: new THREE.Color(0x0a1a3a),
        emissiveIntensity: 0.6,
        side: THREE.DoubleSide // カメラが宝石の内側に入り込んでも面が消えないようにする
      });
      gemMaterials.push(child.material);
      // ======================
      // カット線（ワイヤー）
      // ======================
      const wire = new THREE.LineSegments(
        new THREE.WireframeGeometry(child.geometry),
        new THREE.LineBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.25
        })
      );
      wireMaterials.push(wire.material);
      child.add(wire);
    }
  });
  scene.add(gem);
});

// ======================
// animation（飛び出し）
// ======================
function animate() {
  requestAnimationFrame(animate);

  if (gem) {
    const t = Date.now() * 0.001;

    // 奥→手前（速度も少し上げてキレを出す）
    gem.position.z += 0.22;

    // 左右・上下にふわっと揺れる
    gem.position.x = Math.sin(t * 0.9) * 1.4;
    gem.position.y = Math.sin(t * 1.3) * 0.5;

    // 回転
    gem.rotation.y += 0.02;
    gem.rotation.x = Math.sin(t * 0.6) * 0.3;
    gem.rotation.z += 0.006;

    // 手前に来すぎたらリセット（以前よりずっと手前まで許可）
    if (gem.position.z > END_Z) {
      gem.position.z = START_Z;
    }

    // ---- スケール計算：近づくほど急激に大きくする（イージング） ----
    // 0(奥) 〜 1(カメラ直前) の進行度
    const progress = THREE.MathUtils.clamp(
      (gem.position.z - START_Z) / (END_Z - START_Z),
      0,
      1
    );
    // 3乗イージングで、手前に来た瞬間の「グワッ」とした加速感をさらに強調
    const eased = progress * progress * progress;
    const d = THREE.MathUtils.lerp(MIN_SCALE_FACTOR, MAX_SCALE_FACTOR, eased);

    gem.scale.set(BASE_SCALE * d, BASE_SCALE * d, BASE_SCALE * d);

    // 当たり判定用に、今の宝石のワールド座標上の半径を更新しておく
    currentGemWorldRadius = unitRadius * BASE_SCALE * d;

    // ---- フェード計算 ----
    // 序盤(progress: 0→FADE_RANGE)だけフワッと現れる。
    // 終盤はフェードアウトさせず、最後まで色をフルで残したまま
    // （奥に戻る瞬間だけ一瞬で切り替わる）。
    const fade = THREE.MathUtils.clamp(progress / FADE_RANGE, 0, 1);

    for (const mat of gemMaterials) {
      mat.opacity = BASE_GEM_OPACITY * fade;
    }
    for (const mat of wireMaterials) {
      mat.opacity = BASE_WIRE_OPACITY * fade;
    }
  }

  // ---- 左目・右目それぞれの映像を描画 ----
  // cameraは直接render()に渡していないため、matrixWorldが自動更新されない。
  // stereo.update()はこのmatrixWorldを元に左右のカメラ位置を計算するので、
  // ここで明示的に更新しておく（これを忘れると視差が正しく計算されない）。
  camera.updateMatrixWorld();
  stereo.update(camera);

  renderer.setRenderTarget(rtLeft);
  renderer.render(scene, stereo.cameraL);

  renderer.setRenderTarget(rtRight);
  renderer.render(scene, stereo.cameraR);

  // どちらの目の映像を赤チャンネル/緑チャンネルに使うかをRED_EYEに応じて割り当てる
  if (RED_EYE === "left") {
    composeMaterial.uniforms.tRedEye.value = rtLeft.texture;
    composeMaterial.uniforms.tGreenEye.value = rtRight.texture;
  } else {
    composeMaterial.uniforms.tRedEye.value = rtRight.texture;
    composeMaterial.uniforms.tGreenEye.value = rtLeft.texture;
  }

  // 画面に合成結果を描画
  renderer.setRenderTarget(null);
  renderer.render(composeScene, composeCamera);
}
animate();

// ======================
// resize
// ======================
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  rtLeft.setSize(window.innerWidth, window.innerHeight);
  rtRight.setSize(window.innerWidth, window.innerHeight);
  stereo.aspect = camera.aspect;
});
