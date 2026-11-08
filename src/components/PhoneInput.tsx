/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { ChevronDown, Search, Check } from 'lucide-react';
import { useLanguage } from '../context/LanguageContext';
import { COUNTRIES, CountryCodeOption, parsePhoneComponents, normalisePhone, parseArabicDigits } from '../utils/phoneUtils';

interface PhoneInputProps {
  value: string; // e.g. "+966501234567" or "501234567"
  onChange: (fullNormalizedPhone: string) => void;
  onBlur?: () => void;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  className?: string;
  label?: string;
}

export const PhoneInput: React.FC<PhoneInputProps> = ({
  value,
  onChange,
  onBlur,
  error,
  placeholder,
  disabled = false,
  required = false,
  id,
  className = '',
  label
}) => {
  const { t } = useLanguage();
  const [country, setCountry] = useState<CountryCodeOption>(COUNTRIES[0]); // Saudi Arabia default
  const [nationalNumber, setNationalNumber] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Synchronize internal state from parent value on mount / external change
  useEffect(() => {
    if (value) {
      const { countryCode, nationalNumber: parsedNational } = parsePhoneComponents(value);
      const matched = COUNTRIES.find(c => c.code === countryCode) || COUNTRIES[0];
      setCountry(matched);
      setNationalNumber(parsedNational);
    } else {
      setCountry(COUNTRIES[0]);
      setNationalNumber('');
    }
  }, [value]);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCountrySelect = (selected: CountryCodeOption) => {
    setCountry(selected);
    setIsOpen(false);
    setSearchQuery('');
    
    // Trigger update with new country code
    const full = normalisePhone(selected.code, nationalNumber);
    onChange(full);
  };

  const handleNationalChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = parseArabicDigits(e.target.value);
    // Allow digits, spaces, hyphens
    const cleaned = raw.replace(/[^\d\s-]/g, '');
    
    // Auto-strip leading '0' if Saudi Arabia and starts with '05'
    let national = cleaned;
    if (country.code === '+966' && national.trim().startsWith('05')) {
      national = national.trim().slice(1);
    }

    setNationalNumber(national);
    const full = normalisePhone(country.code, national);
    onChange(full);
  };

  const filteredCountries = COUNTRIES.filter(c => {
    const q = searchQuery.toLowerCase().trim();
    if (!q) return true;
    return (
      c.name.toLowerCase().includes(q) ||
      c.code.includes(q) ||
      c.abbr.toLowerCase().includes(q)
    );
  });

  return (
    <div className={`space-y-1 text-start ${className}`}>
      {label && (
        <label htmlFor={id} className="block text-xs font-bold text-brand-charcoal/80">
          {label} {required && <span className="text-red-500">*</span>}
        </label>
      )}

      <div className="relative flex rounded-xl border border-brand-clay bg-brand-cream focus-within:ring-2 focus-within:ring-brand-terracotta/30 shadow-2xs">
        
        {/* Country Code Trigger Button */}
        <div className="relative shrink-0" ref={dropdownRef}>
          <button
            type="button"
            disabled={disabled}
            onClick={() => setIsOpen(!isOpen)}
            className="flex items-center gap-1.5 h-full px-3 py-3 border-e border-brand-clay bg-brand-sand/40 rounded-s-xl text-xs font-bold text-brand-charcoal hover:bg-brand-sand/70 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
          >
            <span className="text-base leading-none">{country.flag}</span>
            <span>{country.code}</span>
            <ChevronDown className={`h-3.5 w-3.5 text-brand-charcoal/60 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
          </button>

          {/* Searchable Country Code Dropdown */}
          {isOpen && (
            <div className="absolute start-0 top-full mt-1.5 w-[min(18rem,calc(100vw-2rem))] bg-white border border-brand-clay rounded-2xl shadow-xl z-50 overflow-hidden animate-in fade-in duration-150">
              
              {/* Search Header */}
              <div className="p-2.5 border-b border-brand-clay/50 bg-brand-sand/20">
                <div className="relative">
                  <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-brand-charcoal/40" />
                  <input
                    type="text"
                    autoFocus
                    placeholder={t('Search country name or +code...', 'ابحث باسم الدولة أو رمز الاتصال...')}
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    className="w-full bg-white border border-brand-clay rounded-xl py-1.5 ps-8 pe-3 text-xs font-semibold text-brand-charcoal focus:outline-none focus:ring-2 focus:ring-brand-terracotta"
                  />
                </div>
              </div>

              {/* Country List */}
              <div className="max-h-56 overflow-y-auto divide-y divide-brand-clay/20">
                {filteredCountries.length > 0 ? (
                  filteredCountries.map(c => {
                    const isSelected = c.code === country.code;
                    return (
                      <button
                        key={c.code + c.abbr}
                        type="button"
                        onClick={() => handleCountrySelect(c)}
                        className={`w-full flex items-center justify-between px-3 py-2 text-xs text-start hover:bg-brand-sand/40 transition-colors cursor-pointer ${
                          isSelected ? 'bg-brand-sand/60 font-bold text-brand-terracotta' : 'text-brand-charcoal font-medium'
                        }`}
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="text-base">{c.flag}</span>
                          <div>
                            <span className="block font-semibold">{c.name}</span>
                            <span className="text-[10px] text-brand-charcoal/50 font-normal">{c.abbr}</span>
                          </div>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-bold text-brand-charcoal/70">{c.code}</span>
                          {isSelected && <Check className="h-3.5 w-3.5 text-brand-terracotta" />}
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <div className="p-4 text-center text-xs text-brand-charcoal/50 font-semibold">
                    {t('No matching countries found', 'لا توجد دول مطابقة')}
                  </div>
                )}
              </div>

            </div>
          )}
        </div>

        {/* Phone Input Field */}
        <input
          id={id}
          type="tel"
          disabled={disabled}
          required={required}
          placeholder={placeholder || country.example}
          value={nationalNumber}
          onChange={handleNationalChange}
          onBlur={onBlur}
          className="w-full bg-transparent py-3 px-3 text-sm font-semibold text-brand-charcoal focus:outline-none placeholder:text-brand-charcoal/30 disabled:opacity-60"
        />

      </div>

      {error && (
        <p className="text-[11px] font-semibold text-red-600 mt-1">{error}</p>
      )}
    </div>
  );
};
