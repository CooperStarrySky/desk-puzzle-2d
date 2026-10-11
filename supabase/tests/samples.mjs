// Shared test samples: small, valid submissions in the exact format
// the Studio downloads (v1 category, v2 category, v2 full puzzle). Also used by
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

// Version 2 (supabase/SUBMISSION_FORMAT.md): info.title is the label, a slide's
// picture is only scope.image, photos and films use info.image.
const v2Items = (tag, withImages) => [
  { label: `${tag} sticky`, zone: 'corkboard', info: { title: `${tag} sticky`, text: 'Extra detail.' } },
  { label: `${tag} paper`, zone: 'folder', info: { title: `${tag} paper` } },
  withImages
    ? { label: `${tag} photo`, zone: 'photo', info: { title: `${tag} photo`, image: PNG_1x1 }, source: 'My own photo' }
    : { label: `${tag} script`, zone: 'rx', info: { title: `${tag} script` } },
  withImages
    ? { label: `${tag} slide`, zone: 'rack', info: { title: `${tag} slide`, text: 'Look at the nuclei.' }, scope: { image: WEBP_1x1 }, source: 'Wikimedia Commons, CC BY-SA 4.0' }
    : { label: `${tag} film`, zone: 'tubes', info: { title: `${tag} film` } },
];

export function goodSampleV2() {
  const s = goodSample();
  s.version = 2;
  s.group.items = v2Items('Clubbing', true);
  return s;
}

export function goodPuzzleSample() {
  const names = ['TEST: easy things', 'TEST: medium things', 'TEST: hard things', 'TEST: hardest things'];
  return {
    format: 'desk-puzzle-submission', version: 2, kind: 'puzzle',
    submittedAt: '2026-10-11T15:00:00.000Z',
    credit: { mode: 'named', name: 'Test Student', line: 'MS2' },
    contact: { email: 'test.student@rowan.edu' },
    consent: true,
    puzzle: {
      title: 'TEST: automated full puzzle',
      groups: names.map((name, i) => ({
        name, tier: [3, 1, 4, 2][i],
        explanation: `Group ${i + 1} of an automated test puzzle. (Please decline.)`,
        article: [{ type: 'text', text: 'A short teaching note.' }],
        anki: { nids: [1473628085810 + i] },
        items: v2Items(`G${i + 1}`, i < 2),
      })),
    },
  };
}
