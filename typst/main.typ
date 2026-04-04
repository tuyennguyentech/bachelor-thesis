// ─── main.typ ─────────────────────────────────────────────────────────────────
// Entry point — import theo thứ tự: setup → helpers → cover → chapters → refs

// #include "setup.typ"      // page, text, heading styles (side-effect: #set, #show)

// ─── setup.typ ────────────────────────────────────────────────────────────────
// Page, text, paragraph, và heading styles toàn cục

#set document(title: "Báo cáo DATN — Phần 3, 4, 5", author: "Nguyễn Thanh Tuyển")

#set page(
  paper: "a4",
  margin: (top: 2.5cm, bottom: 2.5cm, left: 3cm, right: 2cm),
  numbering: "1",
  number-align: right,
  header: context {
    if counter(page).get().first() > 2 [
      #set text(size: 8.5pt, fill: rgb("#AAAAAA"))
      #grid(
        columns: (1fr, auto),
        [Nền tảng học tập chủ động qua video — IT4995], [DATN 20252],
      )
      #line(length: 100%, stroke: 0.4pt + rgb("#DDDDDD"))
    ]
  },
)

#set text(font: "JetBrainsMono NF", size: 13pt, lang: "vi")
#set par(justify: true, leading: 1.15em, spacing: 1.1em)
#set heading(numbering: "1.1.")

#show heading.where(level: 1): it => {
  pagebreak(weak: true)
  v(0.5em)
  block(
    fill: rgb("#EBF3FC"),
    stroke: (left: 4pt + rgb("#2E75B6")),
    radius: (right: 4pt),
    inset: (left: 12pt, right: 12pt, top: 10pt, bottom: 10pt),
    width: 100%,
  )[#text(size: 13pt, weight: "bold", fill: rgb("#1F3864"), it)]
  v(0.3em)
}

#show heading.where(level: 2): it => {
  v(0.6em)
  text(size: 11.5pt, weight: "bold", fill: rgb("#2E75B6"), it)
  v(0.15em)
}

#show heading.where(level: 3): it => {
  v(0.4em)
  text(size: 10.5pt, weight: "bold", fill: rgb("#1F5C99"), it)
  v(0.05em)
}


#import "helpers.typ": badge, hl, scenario, tbl   // reusable components

#include "cover.typ"

// Mục lục
#outline(title: [Mục lục], depth: 2, indent: 1.5em)

#pagebreak()

// Nội dung chính
#include "chapters/ch1-learning-science.typ"
#include "chapters/ch2-workflow.typ"
#include "chapters/ch3-ai-agents.typ"
#include "chapters/ch4-use-cases.typ"

// Tài liệu tham khảo
#include "references.typ"
