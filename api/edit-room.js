const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function isValidImage(bytes, mimeType) {
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }

  if (mimeType === 'image/png') {
    return bytes.length >= 8
      && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }

  return mimeType === 'image/webp'
    && bytes.length >= 12
    && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'الطريقة غير مدعومة.' });
  }

  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'خدمة التصميم غير مهيأة بعد. أضف OPENAI_API_KEY في إعدادات Vercel.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (error) {
      return res.status(400).json({ error: 'تعذر قراءة بيانات الصورة.' });
    }
  }

  const imageBase64 = body && body.image;
  const mimeType = body && body.mimeType;
  const style = body && body.style;
  if (typeof imageBase64 !== 'string' || typeof mimeType !== 'string'
    || typeof style !== 'string' || style.trim().length === 0 || style.length > 800) {
    return res.status(400).json({ error: 'أرسل صورة ووصف التصميم المطلوب.' });
  }

  const base64 = imageBase64.replace(/^data:image\/(?:jpeg|png|webp);base64,/, '');
  if (!ALLOWED_IMAGE_TYPES.has(mimeType)
    || base64.length === 0
    || base64.length > MAX_BASE64_LENGTH
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return res.status(400).json({ error: 'صيغة الصورة أو حجمها غير مقبول.' });
  }

  const imageBytes = Buffer.from(base64, 'base64');
  if (imageBytes.length > MAX_IMAGE_BYTES || !isValidImage(imageBytes, mimeType)) {
    return res.status(400).json({ error: 'تعذر التحقق من الصورة أو أن حجمها أكبر من 3 MB بعد تجهيزها.' });
  }

  const prompt = [
    'Photorealistically redesign the uploaded photo of a real space according to this style. The image may show a room, apartment, house exterior, office, or another architectural space:',
    style.trim().slice(0, 800),
    'First identify the kind of space in the image. Preserve its recognizable architecture, dimensions, camera viewpoint, perspective, doors, windows, openings, and fixed structural elements. Never add, remove, or move walls, doors, or windows. Apply the requested finishes, furniture, landscaping, and lighting only where appropriate for that type of space. Return one realistic edited photograph without text, labels, borders, or a collage.'
  ].join('\n\n');

  const formData = new FormData();
  formData.append('model', 'gpt-image-1');
  formData.append('prompt', prompt);
  formData.append('quality', 'medium');
  formData.append('size', 'auto');
  const fileExtension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  formData.append('image', new Blob([imageBytes], { type: mimeType }), `room-image.${fileExtension}`);

  let providerResponse;
  try {
    providerResponse = await fetch('https://api.openai.com/v1/images/edits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: formData
    });
  } catch (error) {
    console.error('Image provider request failed:', error.message);
    return res.status(502).json({ error: 'تعذر الاتصال بخدمة تعديل الصور. حاول مرة أخرى.' });
  }

  let result;
  try {
    result = await providerResponse.json();
  } catch (error) {
    console.error('Image provider returned an unreadable response:', providerResponse.status);
    return res.status(502).json({ error: 'وصل رد غير مفهوم من خدمة تعديل الصور.' });
  }

  if (!providerResponse.ok) {
    console.error('Image provider rejected the request:', providerResponse.status);
    if (providerResponse.status === 401 || providerResponse.status === 403) {
      return res.status(502).json({ error: 'مفتاح خدمة تعديل الصور غير صالح أو لا يملك الصلاحية المطلوبة.' });
    }
    if (providerResponse.status === 429) {
      return res.status(429).json({ error: 'الخدمة مشغولة أو تم تجاوز حد الاستخدام. حاول لاحقًا.' });
    }
    return res.status(502).json({ error: 'لم تتمكن الخدمة من تعديل الصورة. تحقق من الصورة والوصف ثم حاول مرة أخرى.' });
  }

  const editedImage = result && result.data && result.data[0] && result.data[0].b64_json;
  if (typeof editedImage !== 'string' || editedImage.length === 0) {
    console.error('Image provider response did not contain an edited image.');
    return res.status(502).json({ error: 'لم تُرجع خدمة التصميم صورة معدّلة. حاول مرة أخرى.' });
  }

  return res.status(200).json({ image: editedImage, mimeType: 'image/png' });
};
