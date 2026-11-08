import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Shield, X } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { PrePaymentPopupConfig, popupTextForLang } from '../types';

interface PrePaymentPopupProps {
  config: PrePaymentPopupConfig;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The pre-payment guidelines overlay shown on the Customer Site.
 *
 * Every value comes from Settings -> Booking Pop-up and is rendered as plain
 * text — never as markup — so nothing an admin types can inject HTML or script.
 */
export const PrePaymentPopup: React.FC<PrePaymentPopupProps> = ({ config, onConfirm, onCancel }) => {
  const [accepted, setAccepted] = useState(false);
  const { lang, t } = useLanguage();
  const blocked = config.requiredCheckbox && !accepted;
  // The customer's language: Arabic fields from Settings when typed, else the
  // built-in translation of a shipped default, else the English. See types.ts.
  const text = popupTextForLang(config, lang);
  const instructions = text.instructions;

  // Rendered into <body>. The checkout page animates itself in, and an animated
  // ancestor keeps a transform on the element, which makes a `fixed` child
  // position against that ancestor instead of the viewport — the overlay was
  // being laid out inside the page rather than over it.
  return createPortal(
    <div className="fixed inset-0 z-50 bg-brand-charcoal/50 backdrop-blur-xs flex items-center justify-center p-4">
      {/* Bounded to the viewport with the body scrolling inside it. overflow-hidden
          stays — it is what clips the accent bar into the rounded corner — but on
          its own it made content taller than the screen unreachable rather than
          scrollable. */}
      <div className="bg-white rounded-3xl max-w-lg w-full shadow-2xl border border-brand-clay text-start animate-in zoom-in-95 duration-150 overflow-hidden flex max-h-[calc(100dvh-2rem)] flex-col">
        <div className="h-1.5 bg-brand-terracotta shrink-0" />

        <div className="p-6 sm:p-7 space-y-4 overflow-y-auto">
          <div className="flex items-start gap-3">
            <div className="p-2 bg-brand-terracotta/10 rounded-xl text-brand-terracotta shrink-0">
              <Shield className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <h3 className="font-display text-lg font-bold text-brand-charcoal leading-tight">
                {text.title}
              </h3>
              <p className="text-[10px] text-brand-charcoal/50 font-bold uppercase tracking-wider mt-0.5">
                {t('Pre-Payment studio briefing', 'إحاطة الاستوديو قبل الدفع')}
              </p>
            </div>
            <button
              type="button"
              onClick={onCancel}
              aria-label={t('Close', 'إغلاق')}
              // Tap area expanded by a transparent pseudo-element rather than
              // by growing the button, which would crowd the heading beside it.
              className="relative p-1.5 rounded-lg text-brand-charcoal/40 hover:bg-brand-sand cursor-pointer shrink-0 before:absolute before:-inset-2 before:content-['']"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="space-y-3 border-y border-brand-clay/40 py-4 max-h-[45vh] overflow-y-auto pe-1">
            {text.paragraphs.map((paragraph, i) => (
              <p key={i} className="text-xs text-brand-charcoal/80 leading-relaxed whitespace-pre-line">
                {paragraph}
              </p>
            ))}

            {instructions.length > 0 && (
              <ul className="space-y-2 pt-0.5">
                {instructions.map((line, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-brand-charcoal/80 leading-relaxed">
                    <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-brand-terracotta shrink-0" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {config.requiredCheckbox && (
            <label className="flex items-start gap-2.5 cursor-pointer">
              <input
                type="checkbox"
                checked={accepted}
                onChange={e => setAccepted(e.target.checked)}
                className="h-4 w-4 accent-brand-terracotta rounded mt-0.5 cursor-pointer shrink-0"
              />
              <span className="text-[11px] font-semibold text-brand-charcoal/75 leading-normal">
                {text.checkboxLabel}
              </span>
            </label>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2.5 rounded-xl border border-brand-clay bg-white text-brand-charcoal/70 text-xs font-bold cursor-pointer hover:bg-brand-sand/40"
            >
              {t('Cancel', 'إلغاء')}
            </button>
            <button
              type="button"
              disabled={blocked}
              onClick={onConfirm}
              className="px-5 py-2.5 rounded-xl bg-brand-terracotta text-brand-cream text-xs font-bold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {text.buttonLabel}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
