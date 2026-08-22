const integerFormatter = new Intl.NumberFormat("en-US");

export function formatTokenUnits(value: bigint, decimals = 6): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = magnitude / scale;
  const fraction = magnitude % scale;
  const fractionText = fraction.toString().padStart(decimals, "0").replace(/0+$/, "");
  const formattedWhole = integerFormatter.format(whole);
  return `${negative ? "-" : ""}${formattedWhole}${fractionText === "" ? "" : `.${fractionText}`}`;
}

export function formatInteger(value: bigint | number): string {
  return integerFormatter.format(value);
}

export function shortHex(value: string, leading = 6, trailing = 4): string {
  if (value.length <= leading + trailing + 1) return value;
  return `${value.slice(0, leading)}…${value.slice(-trailing)}`;
}

export function formatObservedAt(value: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    day: "2-digit",
    month: "short",
    timeZoneName: "short",
  }).format(value);
}
