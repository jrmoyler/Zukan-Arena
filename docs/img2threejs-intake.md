# Img2ThreeJS intake — Nyxalune and the Zukan rig family

Reference: `public/characters/optimized/zukan-001.webp` (577 × 860). Intended use: real-time browser-game fighter with locomotion, hit, cast, knockout, sockets, and collision proxies.

## Layered observation

1. Identification: a stylized chibi reptilian/dragon-like character wearing ceremonial armor and a cape. Primary domain is `character`; the broader 68-fighter roster is `hybrid` because silhouettes include bipeds, quadrupeds, avians, serpentine creatures, constructs, and a swarm. Confidence 0.96.
2. Overall form: approximately 2.7 head-units tall. The head is a large oblate organic volume; the torso is a compact tapered volume; limbs are short capsule-like segments; the tail is a tapering curve-sweep. The visible pose is bilateral and neutral, with a slight three-quarter body turn.
3. Macro hierarchy: root/pelvis, torso, neck/head, two arm chains, two leg chains, tail chain, cape, armor mantle, chest tabard, head crest. Meso structure: shoulder plates, bracers, boots, collar, forehead badge, cape panels. Micro systems: gold trim, scale-like surface relief, shield emblems, seam lines, eye irises/catchlights, engraved cloth bands.
4. Spatial relationships: head is socketed to the neck above the torso; shoulders are socketed laterally into the torso and overlap beneath the mantle; forearms are hinged from upper arms; thighs overlap the pelvis; lower legs hinge at knees; tail is embedded at the posterior pelvis and curves laterally; cape panels hinge from shoulder/back sockets and overlap the body.
5. Materials: skin is saturated indigo dielectric with satin roughness and faint scale relief; eyes are glossy dielectric spheres with purple irises and white catchlights; armor is warm ivory dielectric with metallic gold trim; cape is indigo cloth with lower-frequency embroidered relief; crest and emblems are metallic gold with blue enamel insets.
6. Color/finish: dominant dark indigo; secondary warm ivory; muted antique-gold trim; violet-blue eye gradient; very low-saturation off-white environment. Gold is reflective but not mirror-polished; cloth and skin remain rougher.
7. Identity features: oversized indigo head, shield-and-scales forehead crest, large purple eyes, high ivory collar, layered shoulder armor, long split cape, central scales-of-justice tabard, gold-edged curled tail.
8. Uncertainty: the posterior costume, cape attachment layout, back-side armor, true limb cross-sections, and rear surface art are not observable from this single view. The runtime therefore uses projection-first front identity plus palette-inferred volumetric sides/back. Those hidden regions are approximations, not exact reconstruction.

## Suitability verdict

`character-conditional -> maximum likeness`, accepted for a stylized 2–3 HU game rig. Front silhouette and palette are strong; background contamination, single-view depth ambiguity, and opaque cape overlap make exact hidden geometry impossible. The quality contract targets a strong real-time front/three-quarter match, stable non-degenerate orbit volume, clean joints, and readable animation—not manufacturing-grade or 100% likeness.

## Shared rig route

All 68 fighter images use a common projection-first rig system with archetype-specific skeleton layouts: biped, quadruped, avian, serpentine, construct, and swarm. Every instance exposes named pivots, effect sockets, primitive collider metadata, selectable parts, and animation channels. Reference pixels drive the visible front surface; procedural PBR shells carry depth, lighting, and inferred rear surfaces.
