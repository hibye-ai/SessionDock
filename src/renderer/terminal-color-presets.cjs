'use strict';
// Numeric palette facts: WindTerm 2.7.0 dige themes; SecureCRT 9.7.3 Standard
// ANSI, White / Black and Monochrome. Token matching is independently implemented.
module.exports = {
  "wind": {
    "dark": {
      "theme": {
        "background": "#1c1c1c",
        "foreground": "#f8f8f2",
        "cursor": "#f8f8f2",
        "selectionBackground": "#38385b",
        "black": "#333333",
        "red": "#c4265e",
        "green": "#86b42b",
        "yellow": "#d0a500",
        "blue": "#3465a4",
        "magenta": "#8c6bc8",
        "cyan": "#56adbc",
        "white": "#e3e3dd",
        "brightBlack": "#666666",
        "brightRed": "#f92672",
        "brightGreen": "#a6e22e",
        "brightYellow": "#9e862f",
        "brightBlue": "#819aff",
        "brightMagenta": "#ae81ff",
        "brightCyan": "#66d9ef",
        "brightWhite": "#f8f8f2"
      },
      "semantic": {
        "prompt": "#f8f8f2",
        "command": "#66d9ef",
        "path": "#e6db74",
        "address": "#a6e22e",
        "option": "#fd971f",
        "string": "#e6db74",
        "number": "#ae81ff",
        "success": "#32cd32",
        "error": "#f44747",
        "warning": "#cd9731",
        "boolean": "#f92672",
        "permissions": "#fd971f",
        "sign": "#f92672",
        "info": "#6796e6",
        "debug": "#b267e6"
      }
    },
    "light": {
      "theme": {
        "background": "#ffffff",
        "foreground": "#333333",
        "cursor": "#333333",
        "selectionBackground": "#d2d2ff",
        "black": "#272822",
        "red": "#dc322f",
        "green": "#32cd32",
        "yellow": "#ffd700",
        "blue": "#3465a4",
        "magenta": "#d33682",
        "cyan": "#3a96dd",
        "white": "#d3d3d3",
        "brightBlack": "#333333",
        "brightRed": "#ff7882",
        "brightGreen": "#3cb371",
        "brightYellow": "#d2691e",
        "brightBlue": "#80baff",
        "brightMagenta": "#d778ff",
        "brightCyan": "#78ffff",
        "brightWhite": "#708090"
      },
      "semantic": {
        "prompt": "#333333",
        "command": "#1e90ff",
        "path": "#ff8c00",
        "address": "#20b2aa",
        "option": "#fd971f",
        "string": "#448c27",
        "number": "#dda0dd",
        "success": "#32cd32",
        "error": "#f44747",
        "warning": "#cd9731",
        "boolean": "#4b69c6",
        "permissions": "#fd971f",
        "sign": "#4b69c6",
        "info": "#6796e6",
        "debug": "#b267e6"
      }
    }
  },
  "securecrt": {
    "dark": {
      "theme": {
        "black": "#000000",
        "red": "#a00000",
        "green": "#00a000",
        "yellow": "#a0a000",
        "blue": "#0000a0",
        "magenta": "#a000a0",
        "cyan": "#00a0a0",
        "white": "#c0c0c0",
        "brightBlack": "#808080",
        "brightRed": "#ff0000",
        "brightGreen": "#00ff00",
        "brightYellow": "#ffff00",
        "brightBlue": "#0000ff",
        "brightMagenta": "#ff00ff",
        "brightCyan": "#00ffff",
        "brightWhite": "#ffffff",
        "background": "#000000",
        "foreground": "#ffffff",
        "cursor": "#ffffff",
        "selectionBackground": "#404080"
      },
      "semantic": {
        "error": "#ff0000",
        "warning": "#ffff00",
        "success": "#00ff00",
        "address": "#00ffff"
      }
    },
    "light": {
      "theme": {
        "black": "#000000",
        "red": "#a00000",
        "green": "#00a000",
        "yellow": "#a0a000",
        "blue": "#0000a0",
        "magenta": "#a000a0",
        "cyan": "#00a0a0",
        "white": "#c0c0c0",
        "brightBlack": "#808080",
        "brightRed": "#ff0000",
        "brightGreen": "#00ff00",
        "brightYellow": "#ffff00",
        "brightBlue": "#0000ff",
        "brightMagenta": "#ff00ff",
        "brightCyan": "#00ffff",
        "brightWhite": "#ffffff",
        "background": "#ffffff",
        "foreground": "#000000",
        "cursor": "#000000",
        "selectionBackground": "#c6d4ee"
      },
      "semantic": {
        "error": "#a00000",
        "warning": "#8a6400",
        "success": "#008000",
        "address": "#0000a0"
      }
    }
  }
};
