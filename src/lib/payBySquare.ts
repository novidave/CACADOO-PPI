import "server-only";
import { CurrencyCode, encode, PaymentOptions } from "bysquare/pay";
import QRCode from "qrcode";

/**
 * The PAY by square code of a QR sale (Sklad Predaj, database update 68): the shop's IBAN (and BIC), the payee, the
 * amount in EUR, the variable symbol and the message, encoded by `bysquare` (the Slovak Banking Association's
 * standard) and drawn as an SVG on the server — the browser loads no QR library. Never logged.
 */
export async function payBySquareSvg(p: {
  iban: string;
  bic: string | null;
  payee: string;
  amount: number;
  vs: string;
  message: string;
}): Promise<string> {
  const data = encode({
    payments: [
      {
        type: PaymentOptions.PaymentOrder,
        amount: Math.round(p.amount * 100) / 100,
        currencyCode: CurrencyCode.EUR,
        variableSymbol: p.vs,
        paymentNote: p.message.slice(0, 140),
        beneficiary: { name: p.payee.slice(0, 70) },
        bankAccounts: [p.bic ? { iban: p.iban, bic: p.bic } : { iban: p.iban }],
      },
    ],
  });
  return QRCode.toString(data, { type: "svg", errorCorrectionLevel: "M", margin: 2, color: { dark: "#111111", light: "#ffffff" } });
}
