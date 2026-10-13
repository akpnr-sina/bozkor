-- Starting categories from SPEC section 6. CPV prefixes are a first proposal; the team edits them in /settings.
INSERT INTO "categories" ("id", "name", "cpv_prefixes", "description") VALUES
  ('giyim', 'Giyim ve teçhizat', ARRAY['181', '3581', '351134'], 'Giyim, üniforma, kişisel koruyucu donanım'),
  ('arac-parcalari', 'Araç parçaları', ARRAY['343'], 'Motorlu taşıt parça ve aksesuarları'),
  ('shelter', 'Shelter ve prefabrik yapılar', ARRAY['44211', '39522530'], 'Prefabrik binalar, çadır ve barınaklar'),
  ('guc', 'Güç (jeneratör, dağıtım, kablo)', ARRAY['3112', '312', '313'], 'Jeneratör setleri, güç dağıtım ekipmanı, kablo')
ON CONFLICT ("id") DO NOTHING;
