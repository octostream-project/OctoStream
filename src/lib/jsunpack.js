/**
 * Dean Edwards' p.a.c.k.e.r JavaScript unpacker.
 * Ported from Python (Alfa's jsunpack.py) to JavaScript.
 */

class Unbaser {
  constructor(base) {
    this.base = base;
    this.dictionary = {};
    this.unbase = this._initUnbaser();
  }

  _initUnbaser() {
    if (2 <= this.base && this.base <= 36) {
      return (string) => parseInt(string, this.base);
    }

    const alphabets = {
      62: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ",
      95: " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~",
    };

    if (36 < this.base && this.base < 62) {
      this.alphabet = alphabets[62].slice(0, this.base);
    } else {
      this.alphabet = alphabets[this.base] || "";
    }

    for (let i = 0; i < this.alphabet.length; i++) {
      this.dictionary[this.alphabet[i]] = i;
    }

    return (string) => {
      let ret = 0;
      for (let i = 0; i < string.length; i++) {
        const cipher = string[string.length - 1 - i];
        ret += Math.pow(this.base, i) * this.dictionary[cipher];
      }
      return ret;
    };
  }

  call(string) {
    return this.unbase(string);
  }
}

class UnpackingError extends Error {
  constructor(message) {
    super(message);
    this.name = "UnpackingError";
  }
}

function detect(source) {
  if (typeof source === "string") {
    return /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*/.test(source);
  }
  return false;
}

function unpack(source) {
  if (typeof source !== "string") {
    throw new UnpackingError("Source must be a string");
  }

  const match = source.match(/}\('(.*)',\s*(\d+|\[\]),\s*(\d+),\s*'([^']*)'\.split\('\|'\),\s*(\d+),\s*(.*)\)\)/);
  if (!match) {
    throw new UnpackingError("Could not make sense of p.a.c.k.e.r data");
  }

  let payload = match[1];
  const symtabStr = match[4];
  const radix = match[2] === "[]" ? 62 : parseInt(match[2]);
  const count = parseInt(match[3]);

  const symtab = symtabStr.split("|");
  if (count !== symtab.length) {
    throw new UnpackingError("Malformed p.a.c.k.e.r. symtab.");
  }

  const unbase = new Unbaser(radix);

  const lookup = (word) => {
    const decoded = unbase.call(word);
    return symtab[decoded] || word;
  };

  let unpacked = payload.replace(/\b\w+\b/g, lookup);
  unpacked = _replaceStrings(unpacked);

  return unpacked;
}

function _replaceStrings(source) {
  const match = source.match(/var\s+(_\w+)\s*=\s*\["(.*?)"\];/);
  if (match) {
    const varname = match[1];
    const strings = match[2].split('","');
    const startpoint = source.indexOf(match[0]) + match[0].length;

    let result = source.slice(startpoint);
    for (let i = 0; i < strings.length; i++) {
      const variable = `${varname}[${i}]`;
      result = result.split(variable).join(`"${strings[i]}"`);
    }
    return result;
  }
  return source;
}

export { detect, unpack, Unbaser, UnpackingError };
