/**
 * Back-face expanded outline, the technique MMD and cel-shaded games use to
 * give a character a drawn ink line.
 *
 * A second SkinnedMesh shares the original geometry and skeleton, renders back
 * faces only, and pushes each vertex outward along its view-space normal. The
 * offset scales with view depth so the line keeps a roughly constant thickness
 * on screen no matter how the camera is framed.
 *
 * Implemented by injecting into MeshBasicMaterial rather than as a raw
 * ShaderMaterial: skinning and morph targets require a precise chunk order
 * plus a set of defines and uniforms (morph texture, influences, base
 * influence) that three.js only wires up automatically for its own material
 * types. Letting three own that and replacing just the projection step is both
 * shorter and far less brittle.
 *
 * Per-material widths come from the character config: heavy lines on cloth and
 * hair, a whisper of a line on the face, none at all on the eyes.
 */
import * as THREE from 'three';
import type { MaterialRole, MaterialTuning } from '../config/types';
import type { PmxModel } from '../loaders/pmxTypes';

export interface OutlineOptions {
  /** Global multiplier over every per-material width. */
  scale?: number;
}

/**
 * Build the outline companion mesh for `model`.
 * Returns null when no material asks for an outline.
 */
export function createOutlineMesh(
  model: PmxModel,
  roleOf: (materialName: string) => MaterialRole,
  tuningOf: (role: MaterialRole) => MaterialTuning,
  options: OutlineOptions = {}
): THREE.SkinnedMesh | null {
  const scale = options.scale ?? 1;
  let any = false;

  const materials = model.materials.map((info) => {
    const tuning = tuningOf(roleOf(info.name));
    // Fall back to the width the model author baked into the material.
    const width = (tuning.outlineWidth ?? info.edgeSize) * scale;
    const color = new THREE.Color(tuning.outlineColor ?? info.edgeColor.getHex());

    const material = new THREE.MeshBasicMaterial({
      color,
      side: THREE.BackSide,
      // The outline is a solid silhouette; it must not be lit or tone mapped
      // or it will drift in colour as the lighting changes.
      toneMapped: false,
      fog: false,
      // Critical: push the outline AWAY from the camera in depth.
      //
      // MMD meshes are full of single-sided surfaces (hair cards, coat panels,
      // the face shell). For those, the back face sits at the same position as
      // the front face and carries the same outward-pointing vertex normal, so
      // expanding along that normal drags the outline TOWARD the viewer and it
      // paints over the character instead of ringing it. A depth bias
      // guarantees the character always wins wherever the two coincide, and
      // the outline survives only where it genuinely extends past the
      // silhouette.
      polygonOffset: true,
      polygonOffsetFactor: 2,
      polygonOffsetUnits: 2,
    });
    material.name = `${info.name}__outline`;

    if (width <= 0) {
      material.visible = false;
    } else {
      any = true;
    }

    const uWidth = { value: width };
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uOutlineWidth = uWidth;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uOutlineWidth;'
        )
        .replace(
          '#include <project_vertex>',
          /* glsl */ `
          // Equivalent to <project_vertex>, with the vertex pushed out along
          // its normal in view space before projection.
          vec4 mvPosition = vec4( transformed, 1.0 );
          #ifdef USE_BATCHING
            mvPosition = batchingMatrix * mvPosition;
          #endif
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
          #endif
          mvPosition = modelViewMatrix * mvPosition;

          // -mvPosition.z is the view distance; scaling by it keeps the
          // outline visually constant instead of shrinking with distance.
          mvPosition.xyz += normalize( transformedNormal )
            * max( -mvPosition.z, 0.001 ) * uOutlineWidth * 0.0016;

          gl_Position = projectionMatrix * mvPosition;
          `
        );
    };
    // MeshBasicMaterial only emits the normal chain when skinning or an
    // env map is in play. Skinning is, so `transformedNormal` exists - but
    // make the dependency explicit so it cannot be optimised away.
    material.defines = { ...(material.defines ?? {}), USE_OUTLINE: '' };

    return material;
  });

  if (!any) return null;

  const outline = new THREE.SkinnedMesh(model.mesh.geometry, materials);
  outline.name = `${model.mesh.name}__outline`;
  outline.frustumCulled = false;
  outline.castShadow = false;
  outline.receiveShadow = false;
  // Drawn after the character so the depth buffer already holds her surface;
  // combined with the polygon offset above, the outline can only survive
  // outside her silhouette.
  outline.renderOrder = 1;
  outline.bind(model.skeleton, model.mesh.bindMatrix);

  return outline;
}
