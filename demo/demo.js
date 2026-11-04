"use strict";

// Synthetic examples. The public page has no network connection to the app or database.
const samples = {
  glucose: {
    label: "DEMO-CHEM-01 · GLU · Level 1", mean: 100, sd: 2, unit: "mg/dL",
    scores: [-0.4, 0.6, -1.1, 0.2, 0.9, 2.2, 3.2, -0.5],
  },
  hemoglobin: {
    label: "DEMO-HEMA-01 · HGB · Level 2", mean: 12, sd: 0.2, unit: "g/dL",
    scores: [0.5, -0.7, 0.2, 0.8, -0.9, -2.3, -2.5, 0.6],
  },
};
const item = document.querySelector("#item");
const chart = document.querySelector("#chart");
const records = document.querySelector("#records");

function svg(tag, attributes, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  if (text !== undefined) node.textContent = text;
  return node;
}

function render() {
  const { label, mean, sd, unit, scores } = samples[item.value];
  const rows = scores.map((z, index) => {
    const prior = scores[index - 1];
    const rules = [];
    if (Math.abs(z) > 3) rules.push("1-3s");
    else if (Math.abs(z) > 2) rules.push("1-2s");
    if (Math.abs(z) > 2 && Math.abs(prior) > 2 && Math.sign(z) === Math.sign(prior)) {
      rules.push("2-2s");
    }
    const status = rules.some((rule) => rule !== "1-2s") ? "fail" : rules.length ? "warning" : "pass";
    return { z, status, rules, date: `2026-01-0${index + 1}` };
  });
  const counts = { pass: 0, warning: 0, fail: 0 };
  for (const row of rows) counts[row.status]++;
  document.querySelector("#series-summary").textContent =
    `${label}｜${counts.pass} 通過・${counts.warning} 警告・${counts.fail} 失敗`;

  const x = (index) => 70 + index * 85;
  const y = (score) => 124 - score * 28;
  chart.replaceChildren();
  for (let score = -3; score <= 3; score++) {
    const cssClass = Math.abs(score) === 3 ? "limit" : score === 0 ? "center-line" : "grid";
    chart.append(
      svg("line", { x1: 55, x2: 685, y1: y(score), y2: y(score), class: cssClass }),
      svg("text", { x: 40, y: y(score) + 5, "text-anchor": "end", class: "axis-label" },
        score === 0 ? "0" : `${score > 0 ? "+" : ""}${score}σ`),
    );
  }
  chart.append(svg("polyline", {
    class: "trend", points: rows.map(({ z }, index) => `${x(index)},${y(z)}`).join(" "),
  }));
  rows.forEach(({ z, date, status }, index) => {
    chart.append(
      svg("circle", { cx: x(index), cy: y(z), r: 6, class: status }),
      svg("text", { x: x(index), y: 245, "text-anchor": "middle", class: "axis-label" }, date.slice(5)),
    );
  });

  const statusText = { pass: "通過", warning: "警告", fail: "失敗" };
  records.replaceChildren(...rows.reverse().map(({ date, z, status, rules }) => {
    const row = document.createElement("tr");
    for (const value of [date, `${(mean + z * sd).toFixed(2)} ${unit}`, z.toFixed(2), statusText[status], rules.join("、") || "—"]) {
      row.insertCell().textContent = value;
    }
    row.cells[3].className = status;
    return row;
  }));
}

item.addEventListener("change", render);
render();
