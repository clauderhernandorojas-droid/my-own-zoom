/**
 * Catálogo compartido de herramientas del tablero (emojis, etc.).
 */
(function (global) {
  const BOARD_EMOJIS = [
    "😀", "😂", "😍", "🤔", "👏", "👍", "🎉", "✅", "❓", "💡",
    "📌", "🧠", "📚", "📝", "🧪", "📐", "🧮", "🌍", "🔬", "⚠️",
    "⭐", "🙋", "🤝", "🔁",
  ];

  global.BoardToolCatalog = { BOARD_EMOJIS };
})(typeof window !== "undefined" ? window : global);
