import express from "express";
import { fileURLToPath } from "url";
import path from "path";

const { KAKAO_REST_KEY, DATA_GO_KR_KEY, PORT = 3000 } = process.env;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// ---------- 1) 공공데이터포털: 전국주차장정보표준데이터 ----------
// 반경 검색 파라미터가 없어서, 서버 시작 시 전체를 받아 메모리에 캐시하고 직접 거리 계산
const LOT_API = "https://api.data.go.kr/openapi/tn_pubr_prkplce_info_api";
let LOTS = [];

const num = (v) => Number(v) || 0;
const normalize = (i) => ({
  name: i.prkplceNm,
  kind: i.prkplceSe, // 공영 / 민영
  addr: i.rdnmadr || i.lnmadr || "",
  lat: Number(i.latitude),
  lng: Number(i.longitude),
  base: num(i.basicTime), // 기본시간(분)
  baseFee: num(i.basicCharge), // 기본요금
  unit: num(i.addUnitTime), // 추가 단위시간(분)
  unitFee: num(i.addUnitCharge), // 추가 단위요금
  dayFee: num(i.dayCmmtkt), // 1일 주차권 요금
  feeInfo: i.parkingchrgeInfo || "", // 무료 / 유료
  tel: i.phoneNumber || "",
});

async function loadLots() {
  const all = [];
  const rows = 1000;
  for (let page = 1; ; page++) {
    const url = new URL(LOT_API);
    url.search = new URLSearchParams({
      serviceKey: DATA_GO_KR_KEY, // 포털의 "Decoding" 키를 넣으세요 (이중 인코딩 방지)
      pageNo: page,
      numOfRows: rows,
      type: "json",
    });
    const json = await (await fetch(url)).json();
    const body = json.response?.body ?? json.body;
    if (!body) throw new Error("API 응답 이상: " + JSON.stringify(json).slice(0, 500));
    const items = Array.isArray(body.items) ? body.items : body.items?.item ?? [];
    all.push(...items.map(normalize));
    if (page * rows >= Number(body.totalCount)) break;
  }
  LOTS = all.filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lng) && l.lat && l.lng);
  console.log(`주차장 ${LOTS.length}건 로드 완료`);
}

// ---------- 2) 계산 로직 ----------
function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (d) => (d * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function calcFee(l, mins) {
  if (l.feeInfo === "무료") return 0;
  let fee = mins <= l.base ? l.baseFee : l.baseFee + (l.unit ? Math.ceil((mins - l.base) / l.unit) * l.unitFee : 0);
  if (l.dayFee) fee = Math.min(fee, l.dayFee * Math.ceil(mins / 1440)); // 단순화: 1일권 상한
  return fee;
}

// ---------- 3) 검색 API ----------
app.get("/api/search", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const minutes = Math.max(1, Number(req.query.minutes) || 120);
    const w = Math.min(1, Math.max(0, Number(req.query.w ?? 0.5))); // 1 = 거리 우선
    const radius = Math.min(3000, Number(req.query.radius) || 1000);
    if (!q) return res.status(400).json({ error: "목적지를 입력하세요" });

    // 목적지 -> 좌표 (카카오 로컬 API 키워드 검색)
    const kakao = await fetch(
      "https://dapi.kakao.com/v2/local/search/keyword.json?size=1&query=" + encodeURIComponent(q),
      { headers: { Authorization: `KakaoAK ${KAKAO_REST_KEY}` } }
    ).then((r) => r.json());
    const d = kakao.documents?.[0];
    if (!d) return res.status(404).json({ error: "목적지를 찾을 수 없어요" });
    const dest = { name: d.place_name, addr: d.road_address_name || d.address_name, lat: +d.y, lng: +d.x };

    // 반경 내 주차장 + 요금 계산
    let lots = LOTS.map((l) => ({ ...l, dist: Math.round(haversine(dest.lat, dest.lng, l.lat, l.lng)) }))
      .filter((l) => l.dist <= radius)
      .map((l) => ({ ...l, fee: calcFee(l, minutes), walk: Math.max(1, Math.round(l.dist / 70)) }));

    // 우선순위 점수 (낮을수록 좋음)
    const maxD = Math.max(...lots.map((l) => l.dist), 1);
    const maxF = Math.max(...lots.map((l) => l.fee), 1);
    lots.forEach((l) => (l.score = w * (l.dist / maxD) + (1 - w) * (l.fee / maxF)));
    lots.sort((a, b) => a.score - b.score);

    res.json({ dest, count: lots.length, lots: lots.slice(0, 10) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "서버 오류" });
  }
});

app.get("/", (_, res) => res.sendFile(path.join(__dirname, "index.html")));

await loadLots();
app.listen(PORT, () => console.log(`http://localhost:${PORT}`));
