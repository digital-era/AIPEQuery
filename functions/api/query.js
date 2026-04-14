export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  const code = url.searchParams.get("code");
  const type = url.searchParams.get("type");

  if (!code || !type) {
    return jsonResponse({ detail: "Missing code or type" }, 400);
  }

  try {
    // ==============================
    // ✅ price
    // ==============================
    if (type === "price") {
      const eastmoney = await fetchPriceWithEastmoney(code);
      if (eastmoney) {
        return jsonResponse(eastmoney);
      }

      return jsonResponse(
        { detail: `Price data not found for ${code}` },
        404
      );
    }

    // ==============================
    // ✅ intraday
    // ==============================
    else if (type === "intraday") {
      const eastmoney = await getEastmoneyIntraday(code);
      if (eastmoney) {
        return jsonResponse(eastmoney);
      }

      return jsonResponse(
        { detail: `Intraday data not found for ${code}` },
        404
      );
    }

    // ==============================
    // ❌ 不支持（保持接口结构）
    // ==============================
    else if (type === "info" || type === "movingaveragedata") {
      return jsonResponse(
        { detail: `${type} not supported in Cloudflare Workers` },
        501
      );
    }

    return jsonResponse(
      {
        detail:
          "Invalid 'type' parameter. Use 'price', 'info', 'movingaveragedata', or 'intraday'.",
      },
      400
    );
  } catch (err) {
    return jsonResponse({ detail: err.message }, 500);
  }
}


// ==============================
// ✅ 统一 JSON 返回
// ==============================
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      // ✅ 防抖缓存（重要）
      "Cache-Control": "max-age=5, stale-while-revalidate=10",
    },
  });
}


// ==============================
// ✅ Eastmoney 实时价格（完全对齐 Python）
// ==============================
async function fetchPriceWithEastmoney(code) {
  try {
    const codeUpper = code.toUpperCase();

    let secid, currency, scale;

    if (codeUpper.startsWith("HK")) {
      const pure = codeUpper.replace("HK", "");
      secid = `116.${pure}`;
      currency = "HKD";
      scale = 1000;
    } else if (/^(60|68|51|56|58|55|900)/.test(code)) {
      secid = `1.${code}`;
      currency = "CNY";
      scale = 100;
    } else if (/^(00|30|15|200)/.test(code)) {
      secid = `0.${code}`;
      currency = "CNY";
      scale = 100;
    } else {
      return null;
    }

    const url = `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=f43,f58,f60&ut=fa5fd1943c7b386f172d6893dbfba10b`;

    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (!res.ok) return null;

    const json = await res.json();
    const data = json.data;
    if (!data) return null;

    const latestRaw = data.f43;
    const prevRaw = data.f60;

    if (latestRaw == null || prevRaw == null) return null;

    const latestPrice = latestRaw / scale;
    const prevClose = prevRaw / scale;

    const changeAmount = latestPrice - prevClose;

    // ✅ 精度修复（关键）
    const changePercent = prevClose
      ? Number(((changeAmount / prevClose) * 100).toFixed(6))
      : 0;

    return {
      name: data.f58 || code,
      latestPrice: latestPrice,
      changePercent: changePercent,
      changeAmount: changeAmount,
      source: "eastmoney",
      currency: currency,
      dailydata: null, // ✅ 完全一致
    };
  } catch (e) {
    console.log("Eastmoney price error:", e);
    return null;
  }
}


// ==============================
// ✅ Eastmoney 分时（完全对齐 Python）
// ==============================
async function getEastmoneyIntraday(code) {
  try {
    const codeUpper = code.toUpperCase();

    let secid;

    if (codeUpper.startsWith("HK")) {
      const pure = codeUpper.replace("HK", "");
      secid = `116.${pure}`;
    } else if (/^(60|68|51|56|58|55|900)/.test(code)) {
      secid = `1.${code}`;
    } else if (/^(00|30|15|200)/.test(code)) {
      secid = `0.${code}`;
    } else {
      return null;
    }

    const url = `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ut=fa5fd1943c7b386f172d6893dbfba10b&ndays=1`;

    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const json = await res.json();
    const trends = json?.data?.trends;

    if (!trends) return null;

    let cumulativeAmount = 0;
    let cumulativeVolume = 0;

    const result = [];

    for (const item of trends) {
      const parts = item.split(",");

      const dt = parts[0];
      const price = parseFloat(parts[2]);
      const volume = parseFloat(parts[5]);
      const amount = parseFloat(parts[6]);

      cumulativeAmount += amount;
      cumulativeVolume += volume > 0 ? volume : 0;

      // ✅ 精度修复（关键）
      const avgPrice = cumulativeVolume
        ? Number((cumulativeAmount / cumulativeVolume).toFixed(6))
        : price;

      const [dateStr, timeStrRaw] = dt.split(" ");

      const timeStr =
        timeStrRaw.length === 8 ? timeStrRaw : timeStrRaw + ":00";

      result.push({
        date: dateStr,
        time: timeStr,
        price: price,
        avg_price: avgPrice,
        volume: Number(volume), // ✅ 类型对齐 Python float
      });
    }

    return result;
  } catch (e) {
    console.log("Eastmoney intraday error:", e);
    return null;
  }
}
