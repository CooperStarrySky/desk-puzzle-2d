// Shared test samples: a small, valid category submission in the exact format
// the Studio downloads (desk-puzzle-submission v1). Also used by
// tools/leak_test.mjs --send-sample.
export const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const WEBP_1x1 = 'data:image/webp;base64,UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=';

export const clone = (o) => JSON.parse(JSON.stringify(o));

export function goodSample() {
  return {
    format: 'desk-puzzle-submission', version: 1, kind: 'category',
    submittedAt: '2026-10-10T15:00:00.000Z',
    credit: { mode: 'named', name: 'Test Student', line: 'MS2' },
    contact: { email: 'test.student@rowan.edu' },
    consent: true,
    suggestedTier: 2,
    group: {
      name: 'TEST: things that cause clubbing',
      explanation: 'Each one is a cause of digital clubbing. (Automated test, please decline.)',
      article: [{ type: 'text', text: 'Hypoxia-driven growth factors are the leading theory.' }],
      anki: { nids: [1473628085810] },
      items: [
        { label: 'Bronchiectasis', zone: 'corkboard', info: { title: 'Bronchiectasis', text: 'Chronic airway dilation.' } },
        { label: 'Cyanotic heart disease', zone: 'folder', info: { title: 'Cyanotic heart disease', text: 'Right-to-left shunt.' } },
        { label: 'Lung cancer', zone: 'photo', info: { title: 'Fingertips', text: 'Loss of the nail-fold angle.', image: PNG_1x1 }, source: 'My own photo' },
        { label: 'Mesothelioma', zone: 'rack', info: { title: 'Pleural biopsy', text: 'Asbestos history.', image: WEBP_1x1 },
          scope: { image: WEBP_1x1 }, source: 'Wikimedia Commons, CC BY-SA 4.0' },
      ],
    },
  };
}
