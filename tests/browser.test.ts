import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { InvoiceDraft } from "../shared/dashboard-contract";
import {
  addItemButtonSelectors,
  calculateSunatUnitPrice,
  customerContinueSelectors,
  customerDocumentSelectors,
  customerNameSelectors,
  extractSunatReceiptPrefix,
  falabellaDocumentsTextLooksEmpty,
  formatSunatCurrency,
  normalizeFalabellaCustomerDocumentNumber,
  splitIgv,
} from "../src/browser";

describe("browser helpers", () => {
  test("splits IGV without rounding intermediate amounts", () => {
    const { baseAmount, taxAmount } = splitIgv(99.9);

    expect(baseAmount).toBeCloseTo(84.66101694915254);
    expect(taxAmount).toBeCloseTo(15.23898305084746);
    expect(baseAmount + taxAmount).toBeCloseTo(99.9);
  });

  test("SUNAT: precio unitario neto se formatea con 6 decimales (evita total erróneo por redondeo)", () => {
    const item = {
      description: "x",
      quantity: 6,
      unitPrice: 1.33,
      total: 7.99,
      documentType: "Boleta",
    };
    const base = 7.99 / 1.18;
    const draft: InvoiceDraft = {
      id: "t",
      saleExternalId: "t",
      issueDate: "2026-01-01",
      currency: "PEN",
      customer: { name: "a", documentNumber: "1" },
      items: [item],
      totals: { subtotal: base, tax: 7.99 - base, total: 7.99 },
    };
    const unit = calculateSunatUnitPrice(item, draft);
    const formatted = formatSunatCurrency(unit);

    expect(formatted).toMatch(/^\d+\.\d{6}$/);
    expect(formatted).toBe("1.128531");
    expect(unit * 6 * 1.18).toBeCloseTo(7.99, 2);
  });

  test("prioritizes dojo add item selectors for SUNAT", () => {
    const selectors = addItemButtonSelectors();

    expect(selectors[0]).toBe('span.dijitReset.dijitInline.dijitButtonText:has-text("Adicionar")');
    expect(selectors).toContain(
      "xpath=//*[contains(concat(' ', normalize-space(@class), ' '), ' dijitButtonText ') and contains(normalize-space(.), 'Adicionar')]/ancestor::*[self::a or self::button or @role='button'][1]",
    );
    expect(selectors).toContain("text=Adicionar");
  });

  test("prioritizes the boleta continue button id", () => {
    const selectors = customerContinueSelectors("#boleta\\.botonGrabarDocumento_label");

    expect(selectors[0]).toBe("#boleta\\.botonGrabarDocumento_label");
    expect(selectors).toContain("xpath=//*[@id='boleta.botonGrabarDocumento_label']");
    expect(selectors).toContain(
      "xpath=//*[@id='boleta.botonGrabarDocumento_label']/ancestor::*[@id='boleta.botonGrabarDocumento'][1]",
    );
    expect(selectors).toContain("text=Continuar");
    expect(selectors).toContain(
      "xpath=//*[contains(concat(' ', normalize-space(@class), ' '), ' dijitButtonText ') and contains(normalize-space(.), 'Continuar')]",
    );
  });

  test("prioritizes boleta customer fields", () => {
    const documentSelectors = customerDocumentSelectors("#boleta\\.numeroDocumento");
    const nameSelectors = customerNameSelectors("#boleta\\.razonSocial");

    expect(documentSelectors[0]).toBe("#boleta\\.numeroDocumento");
    expect(documentSelectors).toContain("xpath=//*[@id='boleta.numeroDocumento']");
    expect(nameSelectors[0]).toBe("#boleta\\.razonSocial");
    expect(nameSelectors).toContain("xpath=//*[@id='boleta.razonSocial']");
  });

  test("extracts the SUNAT receipt prefix from the emitted number", () => {
    expect(extractSunatReceiptPrefix("EB01-598")).toBe("EB01");
  });

  test("detects Falabella empty states instead of waiting forever for rows", () => {
    expect(falabellaDocumentsTextLooksEmpty("No hay datos")).toBe(true);
    expect(falabellaDocumentsTextLooksEmpty("Sin resultados para los filtros aplicados")).toBe(true);
    expect(falabellaDocumentsTextLooksEmpty("No data")).toBe(true);
    expect(falabellaDocumentsTextLooksEmpty("3229988096")).toBe(false);
    expect(falabellaDocumentsTextLooksEmpty("Documento pendiente 1 de 2")).toBe(false);
  });

  test("keeps the Falabella customer document digits exactly as shown, including leading zeros", () => {
    expect(normalizeFalabellaCustomerDocumentNumber("00126096")).toBe("00126096");
    expect(normalizeFalabellaCustomerDocumentNumber(" 00 126 096 ")).toBe("00126096");
    expect(normalizeFalabellaCustomerDocumentNumber("N° 00126096")).toBe("00126096");
  });

  test("uses the exact SUNAT ids for the final emit flow in the active profiles", () => {
    const customProfile = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "config/custom-profile.json"), "utf8"),
    ) as { sunat: Record<string, string> };
    const dolphinProfile = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "config/dolphin-profile.json"), "utf8"),
    ) as { sunat: Record<string, string> };

    for (const profile of [customProfile, dolphinProfile]) {
      expect(profile.sunat.finalSubmitSelector).toBe("#boleta-preliminar\\.botonGrabarDocumento");
      expect(profile.sunat.confirmAcceptSelector).toBe("#dlgBtnAceptarConfirm_label");
      expect(profile.sunat.successSelector).toBe("#numeroComprobante");
      expect(profile.sunat.receiptNumberSelector).toBe("#numeroComprobante");
      expect(profile.sunat.pdfDownloadSelector).toBe("#dijit_form_Button_2_label");
    }
  });
});
