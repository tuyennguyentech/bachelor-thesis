// ─── helpers.typ ──────────────────────────────────────────────────────────────
// Reusable components dùng trong toàn bộ báo cáo

// Highlight block có viền trái màu
#let hl(color, body) = box(
  fill: color.lighten(85%),
  stroke: (left: 2.5pt + color),
  radius: (right: 3pt),
  inset: (left: 9pt, right: 9pt, top: 7pt, bottom: 7pt),
  width: 100%,
)[#body]

// Badge nhỏ inline (dùng trong bảng, heading)
#let badge(color, text-content) = box(
  fill: color.lighten(80%),
  stroke: 0.5pt + color,
  radius: 3pt,
  inset: (x: 5pt, y: 2pt),
)[#text(size: 8.5pt, fill: color, weight: "bold")[#text-content]]

// Bảng có style nhất quán
// cols  : array column widths, e.g. (2.2cm, 1fr, 3.8cm)
// header: array of header strings
// rows  : array of arrays (mỗi row là 1 array cell)
#let tbl(cols, header, rows) = table(
  columns: cols,
  stroke: (x, y) => if y == 0 { (bottom: 1pt + rgb("#2E75B6")) }
                    else { (bottom: 0.4pt + rgb("#E0E0E0")) },
  fill: (_, y) => if y == 0 { rgb("#EBF3FC") }
                  else if calc.odd(y) { white } else { rgb("#F8FBFF") },
  inset: (x: 7pt, y: 6pt),
  ..header.map(h => text(weight: "bold", size: 9.5pt)[#h]),
  ..rows.flatten().map(c => text(size: 9.5pt)[#c]),
)

// Khối kịch bản sử dụng (Use Case)
// id      : "UC-01"
// actor   : "Actor: Instructor"
// precond : điều kiện tiền đề
// steps   : array các bước (content)
#let scenario(id, actor, precond, steps) = block(
  stroke: (left: 3pt + rgb("#2E75B6"), rest: 0.5pt + rgb("#E0E0E0")),
  radius: (right: 6pt),
  inset: 0pt,
  width: 100%,
  breakable: true,
)[
  // Header: ID + Actor
  #block(
    fill: rgb("#EBF3FC"),
    width: 100%,
    inset: (x: 14pt, y: 10pt),
    radius: (top-right: 6pt),
  )[
    #grid(columns: (auto, 1fr), gutter: 10pt, align: (center, left + horizon),
      block(fill: rgb("#2E75B6"), radius: 4pt, inset: (x: 10pt, y: 4pt))[
        #text(weight: "bold", fill: white, size: 9pt)[#id]
      ],
      text(size: 10.5pt, weight: "bold", fill: rgb("#1F3864"))[#actor],
    )
  ]
  // Precondition
  #block(
    fill: rgb("#F8F9FA"),
    width: 100%,
    inset: (x: 14pt, y: 8pt),
  )[
    #text(size: 8.5pt, weight: "bold", fill: rgb("#888888"))[Điều kiện: ]
    #text(size: 9pt, fill: rgb("#555555"), style: "italic")[#precond]
  ]
  // Steps
  #block(inset: (x: 14pt, top: 8pt, bottom: 12pt))[
    #for (i, s) in steps.enumerate() [
      #grid(columns: (22pt, 1fr), gutter: 8pt, align: (center + top, left),
        block(fill: rgb("#2E75B6"), radius: 50%, width: 22pt, height: 22pt)[
          #align(center + horizon)[
            #text(size: 9pt, weight: "bold", fill: white)[#(i + 1)]
          ]
        ],
        block(inset: (top: 2pt))[#s],
      )
      #if i < steps.len() - 1 { v(6pt) }
    ]
  ]
]
