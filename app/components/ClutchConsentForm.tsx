'use client';

import React, { useMemo, useState } from 'react';
import { Upload, FileText, Car, AlertCircle, CheckCircle, Loader2, Download } from 'lucide-react';

type ExtractedPayload = {
  fullName: string;
  address: string;
  year: string;
  makeModel: string;
  vin: string;
};

type FormDataState = ExtractedPayload & {
  date: string;
};

type AnthropicContentItem =
  | { type: 'text'; text: string }
  | {
      type: 'image' | 'document';
      source: { type: 'base64'; media_type: string; data: string };
    };

type AnthropicResponse = {
  content?: Array<{ type: 'text'; text: string } | Record<string, unknown>>;
};

const allowedTypes = ['application/pdf', 'image/jpeg', 'image/jpg', 'image/png'] as const;
type AllowedMime = (typeof allowedTypes)[number];

const isAllowedMime = (t: string): t is AllowedMime => (allowedTypes as readonly string[]).includes(t);

const todayISO = () => new Date().toISOString().split('T')[0];

const ClutchConsentForm: React.FC = () => {
  const [file, setFile] = useState<File | null>(null);
  const [extracting, setExtracting] = useState(false);

  const [formData, setFormData] = useState<FormDataState>({
    fullName: '',
    address: '',
    year: '',
    makeModel: '',
    vin: '',
    date: todayISO(),
  });

  const [extractionComplete, setExtractionComplete] = useState(false);
  const [error, setError] = useState('');

  // ⚠️ IMPORTANT:
  // Vercel/Next.js can’t safely use a client-side API key. You must add your own server route
  // if you want Anthropic extraction in production. Right now this will likely fail unless
  // the endpoint allows your request (it usually requires an API key).
  const extractEnabled = useMemo(() => true, []);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const uploadedFile = e.target.files?.[0] ?? null;
    if (!uploadedFile) return;

    if (!isAllowedMime(uploadedFile.type)) {
      setError('Please upload a PDF or image file (JPG/PNG)');
      setFile(null);
      setExtractionComplete(false);
      return;
    }

    setFile(uploadedFile);
    setError('');
    setExtractionComplete(false);

    // reset the input so selecting the same file again triggers onChange
    e.target.value = '';

    if (extractEnabled) {
      await extractInformation(uploadedFile);
    }
  };

  const fileToBase64 = (f: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') return reject(new Error('Unexpected FileReader result'));
        const parts = result.split(',');
        if (parts.length < 2) return reject(new Error('Invalid base64 data URL'));
        resolve(parts[1]);
      };
      reader.onerror = () => reject(new Error('FileReader failed'));
      reader.readAsDataURL(f);
    });

  const extractInformation = async (f: File) => {
    setExtracting(true);
    setError('');

    try {
      const base64Data = await fileToBase64(f);

      const mediaType = f.type;
      const sourceType: 'document' | 'image' = mediaType === 'application/pdf' ? 'document' : 'image';

      const body = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: sourceType,
                source: { type: 'base64', media_type: mediaType, data: base64Data },
              },
              {
                type: 'text',
                text: `Extract the following information from this insurance slip and return ONLY valid JSON with no preamble or markdown:

{
  "fullName": "customer full name",
  "address": "full address",
  "year": "vehicle year",
  "makeModel": "vehicle make and model",
  "vin": "vehicle identification number"
}

If any field is not found, use an empty string. Ensure the response is valid JSON only.`,
              },
            ] as AnthropicContentItem[],
          },
        ],
      };

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // NOTE: Anthropic typically requires an API key header. Don’t put it here in the browser.
          // Use a Next.js API route instead if you want this working on Vercel.
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw new Error(`API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as AnthropicResponse;

      const textContent =
        data.content
          ?.filter((item) => (item as any).type === 'text' && typeof (item as any).text === 'string')
          .map((item) => (item as any).text as string)
          .join('\n') ?? '';

      if (!textContent.trim()) {
        throw new Error('No text content extracted');
      }

      const cleanJson = textContent.replace(/```json|```/g, '').trim();

      let extracted: Partial<ExtractedPayload> = {};
      try {
        extracted = JSON.parse(cleanJson) as Partial<ExtractedPayload>;
      } catch {
        // Sometimes models return extra text; try to salvage the first JSON object.
        const match = cleanJson.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('Could not parse JSON from extracted text');
        extracted = JSON.parse(match[0]) as Partial<ExtractedPayload>;
      }

      setFormData((prev) => ({
        fullName: extracted.fullName ?? prev.fullName,
        address: extracted.address ?? prev.address,
        year: extracted.year ?? prev.year,
        makeModel: extracted.makeModel ?? prev.makeModel,
        vin: extracted.vin ?? prev.vin,
        date: prev.date,
      }));

      setExtractionComplete(true);
    } catch (err) {
      console.error('Extraction error:', err);
      setError('Could not extract information from this file. Please fill the form manually below.');
    } finally {
      setExtracting(false);
    }
  };

  const handleInputChange = (field: keyof FormDataState, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));

    if (field === 'vin' && value.length === 17) {
      void decodeVIN(value);
    }
  };

  const decodeVIN = async (vin: string) => {
    try {
      const response = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVin/${encodeURIComponent(vin)}?format=json`);
      if (!response.ok) return;

      const data: {
        Results?: Array<{ Variable?: string; Value?: string | null }>;
      } = await response.json();

      const results = data.Results ?? [];
      const findValue = (variable: string) =>
        results.find((item) => item.Variable === variable)?.Value ?? '';

      const make = findValue('Make');
      let model = findValue('Model');

      if (!model || model === 'Not Applicable') model = findValue('Series');
      if (!model || model === 'Not Applicable') model = findValue('Trim');

      const year = findValue('Model Year');

      let makeModelStr = '';
      if (make && make !== 'Not Applicable') makeModelStr = make;
      if (model && model !== 'Not Applicable') makeModelStr = makeModelStr ? `${makeModelStr} ${model}` : model;

      setFormData((prev) => ({
        ...prev,
        vin,
        makeModel: makeModelStr || prev.makeModel,
        year: year && year !== 'Not Applicable' ? year : prev.year,
      }));
    } catch (err) {
      console.error('VIN decode error:', err);
    }
  };

  const generatePDF = () => {
    try {
      const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const dateObj = new Date(formData.date);
      const formattedDate = `${months[dateObj.getMonth()]} ${dateObj.getDate()}, ${dateObj.getFullYear()}`;

      const canvas = document.createElement('canvas');
      canvas.width = 850;
      canvas.height = 1100;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas not supported');

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#000000';

      let y = 80;

      ctx.font = 'bold 22px Arial';
      ctx.textAlign = 'center';
      ctx.fillText('AUTHORIZATION LETTER', canvas.width / 2, y);
      ctx.beginPath();
      ctx.moveTo(250, y + 5);
      ctx.lineTo(600, y + 5);
      ctx.stroke();

      y += 50;
      ctx.textAlign = 'left';

      ctx.font = 'bold 14px Arial';
      ctx.fillText('Full Name:', 60, y);
      ctx.font = '14px Arial';
      ctx.fillText(formData.fullName, 160, y);
      y += 25;

      ctx.font = 'bold 14px Arial';
      ctx.fillText('Address:', 60, y);
      ctx.font = '14px Arial';
      ctx.fillText(formData.address, 160, y);
      y += 25;

      ctx.font = 'bold 14px Arial';
      ctx.fillText('Date:', 60, y);
      ctx.font = '14px Arial';
      ctx.fillText(formattedDate, 160, y);
      y += 40;

      ctx.font = 'bold 14px Arial';
      ctx.fillText('To: Access Nova Scotia', 60, y);
      y += 30;

      ctx.font = '14px Arial';
      ctx.fillText(`I, ${formData.fullName}, authorize an employee of Clutch technologies Inc., to act`, 60, y);
      y += 20;
      ctx.fillText('on my behalf for the purpose of:', 60, y);
      y += 25;

      ctx.fillText('•  Registering the vehicle listed below', 80, y);
      y += 20;
      ctx.fillText('•  Obtaining new licence plates', 80, y);
      y += 20;
      ctx.fillText('•  Submitting or receiving relevant documentation', 80, y);
      y += 35;

      ctx.font = 'bold 14px Arial';
      ctx.fillText('Vehicle Information:', 60, y);
      y += 25;

      ctx.fillText('Year:', 60, y);
      ctx.font = '14px Arial';
      ctx.fillText(formData.year, 160, y);
      y += 20;

      ctx.font = 'bold 14px Arial';
      ctx.fillText('Make & Model:', 60, y);
      ctx.font = '14px Arial';
      ctx.fillText(formData.makeModel, 180, y);
      y += 20;

      ctx.font = 'bold 14px Arial';
      ctx.fillText('VIN:', 60, y);
      ctx.font = '14px Arial';
      ctx.fillText(formData.vin, 160, y);
      y += 35;

      ctx.font = 'bold 14px Arial';
      ctx.fillText('Documents Provided:', 60, y);
      y += 25;

      ctx.font = '14px Arial';
      ctx.fillText('•  Copy of valid driver license', 80, y);
      y += 20;
      ctx.fillText('•  Proof of insurance', 80, y);
      y += 20;
      ctx.fillText('•  Vehicle registration', 80, y);
      y += 30;

      ctx.font = '14px Arial';
      ctx.fillText('I understand that I am responsible for all transactions completed on my behalf. By signing this', 60, y);
      y += 18;
      ctx.fillText(`form, the customer authorizes Clutch Technologies INC. to charge the customer${String.fromCharCode(39)}s credit card for`, 60, y);
      y += 18;
      ctx.fillText('plating services, including any applicable taxes or fees.', 60, y);
      y += 40;

      ctx.font = 'bold 14px Arial';
      ctx.fillText('Signature (Digital):', 60, y);
      ctx.beginPath();
      ctx.moveTo(200, y);
      ctx.lineTo(420, y);
      ctx.stroke();

      ctx.fillText('Printed Name:', 480, y);
      ctx.beginPath();
      ctx.moveTo(590, y);
      ctx.lineTo(780, y);
      ctx.stroke();

      canvas.toBlob(
        (blob) => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = `Authorization_Letter_${formData.fullName.trim().replace(/\s+/g, '_') || 'Customer'}.jpg`;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);
        },
        'image/jpeg',
        0.95
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Error:', err);
      setError('Failed to generate image: ' + msg);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-red-50 to-white p-6">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <div className="flex items-center gap-3 mb-6 pb-6 border-b">
            <div className="text-4xl font-bold text-red-600 tracking-tight">clutch</div>
          </div>

          <div className="mb-6">
            <h1 className="text-2xl font-bold text-gray-900">Consent Form</h1>
            <p className="text-gray-600 text-sm">Auto-fill from insurance slip</p>
          </div>

          <div className="mb-8">
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Upload Insurance Slip (PDF or Image)
            </label>

            <div className="border-2 border-dashed border-gray-300 rounded-lg p-6 text-center hover:border-red-500 transition-colors">
              <input
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                onChange={handleFileUpload}
                className="hidden"
                id="file-upload"
              />
              <label htmlFor="file-upload" className="cursor-pointer">
                <Upload className="mx-auto mb-3 text-gray-400" size={40} />
                <p className="text-sm text-gray-600">{file ? file.name : 'Click to upload or drag and drop'}</p>
                <p className="text-xs text-gray-500 mt-1">PDF, JPG, or PNG</p>
              </label>
            </div>
          </div>

          {extracting && (
            <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-lg flex items-center gap-3">
              <Loader2 className="text-blue-600 animate-spin" size={20} />
              <span className="text-blue-800">Extracting information from insurance slip...</span>
            </div>
          )}

          {extractionComplete && (
            <div className="mb-6 p-4 bg-green-50 border border-green-200 rounded-lg flex items-center gap-3">
              <CheckCircle className="text-green-600" size={20} />
              <span className="text-green-800">Information extracted! Please review and edit as needed.</span>
            </div>
          )}

          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-3">
              <AlertCircle className="text-red-600" size={20} />
              <span className="text-red-800">{error}</span>
            </div>
          )}

          <div className="space-y-6">
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <FileText size={20} />
              Customer Information
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Full Name</label>
                <input
                  type="text"
                  value={formData.fullName}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleInputChange('fullName', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  placeholder="John Doe"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Address</label>
                <input
                  type="text"
                  value={formData.address}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleInputChange('address', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  placeholder="123 Main St, Halifax, NS B3H 1A1"
                />
              </div>
            </div>

            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2 pt-4">
              <Car size={20} />
              Vehicle Information
            </h2>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Year</label>
                <input
                  type="text"
                  value={formData.year}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleInputChange('year', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  placeholder="2020"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-sm font-medium text-gray-700 mb-1">Make & Model</label>
                <input
                  type="text"
                  value={formData.makeModel}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleInputChange('makeModel', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-transparent"
                  placeholder="Honda Civic"
                />
              </div>

              <div className="md:col-span-3">
                <label className="block text-sm font-medium text-gray-700 mb-1">VIN</label>
                <input
                  type="text"
                  value={formData.vin}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleInputChange('vin', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-transparent font-mono"
                  placeholder="1HGBH41JXMN109186"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Date</label>
                <input
                  type="date"
                  value={formData.date}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => handleInputChange('date', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-2 focus:ring-red-500 focus:border-transparent"
                />
              </div>
            </div>

            <div className="pt-6 border-t">
              <button
                onClick={generatePDF}
                disabled={!formData.fullName.trim()}
                className="w-full bg-red-600 text-white py-3 px-6 rounded-lg font-semibold hover:bg-red-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
              >
                <Download size={20} />
                <span>Download Authorization Letter</span>
              </button>
              <p className="text-xs text-gray-500 text-center mt-2">
                {formData.fullName.trim() ? 'Downloads as JPG image file' : 'Please enter customer name to continue'}
              </p>
            </div>

            <p className="text-xs text-gray-500">
              Note: If extraction fails on Vercel, it’s because Anthropic requires an API key and browsers can’t safely store it.
              The correct production approach is a Next.js API route that calls Anthropic server-side.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ClutchConsentForm;
