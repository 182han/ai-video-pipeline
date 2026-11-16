// ============================================================
// 提示词助手 · Liquid Orb（WebGL2 移植）
// ------------------------------------------------------------
// 形态来源：用户提供的 Swift / Metal LiquidOrbView（style = 24，
//   particleRibbon + glass 外壳）。原实现是 iOS/macOS 的 MTKView；
//   这里把「粒子缎带 + 玻璃球」这一形态移植到浏览器 WebGL2，
//   只保留 style 24 需要的子集，不引入任何 npm 依赖。
//
// 结构：
//   1) ribbon pass：6 层 × (192×48) 实例化粒子，画进离屏纹理
//   2) composite pass：玻璃外壳 + 折射采样，合成到 canvas
// 状态：idle / thinking 两套 uniform seed，按原实现的
//   activation 0.17s / settle 0.5s 做 sRGB 插值过渡。
//
// 不支持 WebGL2 时 createOrb() 返回 null，调用方用 CSS 球兜底。
// ============================================================

const IDLE_SEED = [
  1, 1, 0, 1.7599999904632568, 0.6600000262260437, 0.30000001192092896, 3, 0.5,
  2.200000047683716, 0.11999999731779099, 0.2800000011920929, 0.23999999463558197, 0.18000000715255737, 0.18000000715255737, 1.0063999891281128, 24,
  0.004999999888241291, 0, 0, 1, 0.4399999976158142, 0, 2, 0.41999998688697815,
  0.7699999809265137, 0.23000000417232513, 65, 0, 0, 1, 0.2199999988079071, 0.25,
  1, 4, 0.29760000109672546, 0.4830000102519989, 0.20999999344348907, 0.06840000301599503, 1.1200000047683716, 1.2200000286102295,
  0.04313725605607033, 0.7803921699523926, 0.9372549057006836, 1, 0.26274511218070984, 0.8980392217636108, 0.4431372582912445, 1,
  0.5568627715110779, 0.9764705896377563, 0.04313725605607033, 1, 0.027450980618596077, 0.027450980618596077, 0.01568627543747425, 1,
  0.7254902124404907, 0.800000011920929, 0.8196078538894653, 1, 1, 1, 1, 1,
  0.6078431606292725, 0.95686274766922, 1, 1, 0.772549033164978, 0.6627451181411743, 1, 1,
  0.9176470637321472, 0.95686274766922, 1, 1, 0.8627451062202454, 0.9176470637321472, 1, 1,
  0, 0, 0, 1, 0.3176470696926117, 0.2980392277240753, 0.47058823704719543, 1,
  0.9686274528503418, 0.9843137264251709, 1, 1, 0.9372549057006836, 0.9647058844566345, 0.9921568632125854, 1,
  0.8784313797950745, 0.9333333373069763, 0.9764705896377563, 1, 0.8313725590705872, 0.9019607901573181, 0.9686274528503418, 1,
  0.7333333492279053, 0.8352941274642944, 0.9529411792755127, 1, 0.6509804129600525, 0.7803921699523926, 0.9411764740943909, 1,
  0.529411792755127, 0.6901960968971252, 0.9215686321258545, 1, 0.43529412150382996, 0.6196078658103943, 0.9098039269447327, 1,
  0.43529412150382996, 0.6196078658103943, 0.9098039269447327, 1, 0.43529412150382996, 0.6196078658103943, 0.9098039269447327, 1,
  0.43529412150382996, 0.6196078658103943, 0.9098039269447327, 1, 0.43529412150382996, 0.6196078658103943, 0.9098039269447327, 1
];

const THINKING_SEED = [
  1, 1, 0, 2.819999933242798, 0.6600000262260437, 0.30000001192092896, 3, 0.5,
  2.200000047683716, 0.11999999731779099, 0.2800000011920929, 0.23999999463558197, 0.18000000715255737, 0.18000000715255737, 1.4800000190734863, 24,
  0.004999999888241291, 0, 0, 1, 0.4399999976158142, 0, 2, 0.41999998688697815,
  0.7699999809265137, 0.23000000417232513, 65, 0, 0, 1, 0.2199999988079071, 0.25,
  1, 4, 0.47999998927116394, 1.149999976158142, 0.6000000238418579, 0.3799999952316284, 1.1200000047683716, 1.2200000286102295,
  0.03529411926865578, 0.43529412150382996, 0.8078431487083435, 1, 0.29019609093666077, 1, 0.46666666865348816, 1,
  0.03529411926865578, 0.9450980424880981, 0.3529411852359772, 1, 0.9333333373069763, 0.8078431487083435, 0.30980393290519714, 1,
  0.1568627506494522, 0.40784314274787903, 0.15294118225574493, 1, 1, 1, 1, 1,
  0.6078431606292725, 0.95686274766922, 1, 1, 0.772549033164978, 0.6627451181411743, 1, 1,
  0.9176470637321472, 0.95686274766922, 1, 1, 0.8627451062202454, 0.9176470637321472, 1, 1,
  0, 0, 0, 1, 0.4627451002597809, 0.3607843220233917, 1, 1,
  0.9686274528503418, 0.9843137264251709, 1, 1, 0.9372549057006836, 0.9647058844566345, 0.9921568632125854, 1,
  0.8784313797950745, 0.9333333373069763, 0.9764705896377563, 1, 0.8313725590705872, 0.9019607901573181, 0.9686274528503418, 1,
  0.7333333492279053, 0.8352941274642944, 0.9529411792755127, 1, 0.6509804129600525, 0.7803921699523926, 0.9411764740943909, 1,
  0.529411792755127, 0.6901960968971252, 0.9215686321258545, 1, 0.43529412150382996, 0.6196078658103943, 0.9098039269447327, 1,
  0.43529412150382996, 0.6196078658103943, 0.9098039269447327, 1, 0.43529412150382996, 0.6196078658103943, 0.9098039269447327, 1,
  0.43529412150382996, 0.6196078658103943, 0.9098039269447327, 1, 0.43529412150382996, 0.6196078658103943, 0.9098039269447327, 1
];

const SEED_LEN = 136;
const ACTIVATION = 0.17;
const SETTLE = 0.5;

// Web 端每层粒子数：原实现 384×96；96px 球在这个量级下 192×48 足够，
// 观感一致但实例数从 221184 降到 55296（4 层活跃 ≈ 3.7 万）。
const PR_U_SEGMENTS = 224;
const PR_V_SEGMENTS = 56;
const PR_PER_LAYER = PR_U_SEGMENTS * PR_V_SEGMENTS;
const INSTANCE_COUNT = PR_PER_LAYER * 6;

const UNIFORM_BLOCK = `
layout(std140) uniform Uniforms {
  vec2 uSize;
  float uTime;
  float uSpeed;
  float uRadius;
  float uZoom;
  float uWarp;
  float uRidgeAmt;
  float uSharp;
  float uShade;
  float uSheen;
  float uGloss;
  float uShellMidAlpha;
  float uShellEdgeAlpha;
  float uExposure;
  float uStyle;
  float uEdgeSoftness;
  float uEdgeGlow;
  float uPaletteCount;
  float uGlassEnabled;
  float uGlassOpacity;
  float uContourDeform;
  float uBandDensity;
  float uChromaticShift;
  float uMetalScale;
  float uMetalStretch;
  float uMetalAngle;
  float uMetalOffset;
  float uMetalPhase;
  float uMetalEvolution;
  float uMetalRoughness;
  float uMetalDepth;
  float uParticleDensity;
  float uRibbonCount;
  float uRibbonWidth;
  float uRibbonTwist;
  float uRibbonFold;
  float uRibbonBreath;
  float uParticleSize;
  float uParticleBloom;
  vec4 uColorA;
  vec4 uColorB;
  vec4 uColorC;
  vec4 uColorD;
  vec4 uHighlightColor;
  vec4 uShellInner;
  vec4 uShellMid;
  vec4 uShellEdge;
  vec4 uSheenColor;
  vec4 uSpecColor;
  vec4 uCanvasColor;
  vec4 uGlowColor;
  vec4 uPalette0;
  vec4 uPalette1;
  vec4 uPalette2;
  vec4 uPalette3;
  vec4 uPalette4;
  vec4 uPalette5;
  vec4 uPalette6;
  vec4 uPalette7;
  vec4 uPalette8;
  vec4 uPalette9;
  vec4 uPalette10;
  vec4 uPalette11;
};
`;

const PR_COMMON = `
const float PI2 = 6.28318530718;
const vec2 GL_FU = vec2(0.8817204);
const float GL_CLEAR_EA = 0.995;
const float GL_CLEAR_EB = 1.04;

float prHash(float value) {
  return fract(sin(value * 12.9898 + 78.233) * 43758.5453);
}

vec3 prRotateX(vec3 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}

vec3 prRotateY(vec3 p, float angle) {
  float c = cos(angle);
  float s = sin(angle);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}

vec3 prCurve(float theta, float layer, float phase) {
  float local = theta + layer * 0.11;
  float foldPhase = 2.0 * local + phase * (0.72 + layer * 0.025);
  float fold = clamp(uRibbonFold, 0.0, 1.2);
  float radial = 0.4 + (0.085 + fold * 0.04) * cos(foldPhase);
  float orbit = local + phase * 0.13
              + sin(local - phase * 0.22 + layer) * fold * 0.13;
  float vertical = (0.235 + fold * 0.085) * sin(foldPhase)
                 + 0.055 * sin(local * 3.0 - phase * 0.46 + layer * 0.7);
  return vec3(radial * cos(orbit), vertical, radial * sin(orbit));
}

vec3 prPalette(float valueIn) {
  float value = fract(valueIn) * 4.0;
  if (value < 1.0) return mix(uColorA.xyz, uColorB.xyz, value);
  if (value < 2.0) return mix(uColorB.xyz, uColorC.xyz, value - 1.0);
  if (value < 3.0) return mix(uColorC.xyz, uColorD.xyz, value - 2.0);
  return mix(uColorD.xyz, uColorA.xyz, value - 3.0);
}
`;

const RIBBON_VS = `#version 300 es
precision highp float;
precision highp int;
${UNIFORM_BLOCK}
${PR_COMMON}
const uint PR_U_SEGMENTS = ${PR_U_SEGMENTS}u;
const uint PR_V_SEGMENTS = ${PR_V_SEGMENTS}u;
const uint PR_PER_LAYER = PR_U_SEGMENTS * PR_V_SEGMENTS;

const vec2 corners[6] = vec2[6](
  vec2(-1.0, -1.0), vec2(1.0, -1.0),
  vec2(-1.0, 1.0),  vec2(-1.0, 1.0),
  vec2(1.0, -1.0),  vec2(1.0, 1.0)
);

out vec2 vLocal;
out vec3 vColor;
out float vOpacity;

void main() {
  uint instanceIndex = uint(gl_InstanceID);
  uint layerIndex = instanceIndex / PR_PER_LAYER;
  uint particleIndex = instanceIndex % PR_PER_LAYER;
  uint uIndex = particleIndex / PR_V_SEGMENTS;
  uint vIndex = particleIndex % PR_V_SEGMENTS;
  float layer = float(layerIndex);
  float random = prHash(float(instanceIndex));
  bool activeLayer = layer < floor(clamp(uRibbonCount, 2.0, 6.0) + 0.5);

  float uCoord = (float(uIndex) + prHash(float(instanceIndex) + 11.0) * 0.56)
               / float(PR_U_SEGMENTS);
  float vCoord = (float(vIndex) + prHash(float(instanceIndex) + 29.0) * 0.46)
               / float(PR_V_SEGMENTS);
  float strip = vCoord * 2.0 - 1.0;
  float tt = uTime * uSpeed;
  float phase = tt * 0.48;
  float arc = fract(uCoord + layer * 0.211 - phase * 0.019);
  float arcLength = 0.76 + 0.055 * sin(tt * 0.23 + layer * 1.71);
  float arcPosition = arc / arcLength;
  float arcEnvelope = smoothstep(0.0, 0.075, arcPosition)
                    * (1.0 - smoothstep(0.88, 1.0, arcPosition));
  bool isActive = activeLayer
             && arc <= arcLength
             && random <= clamp(uParticleDensity, 0.2, 1.0);
  float theta = uCoord * PI2;
  vec3 center = prCurve(theta, layer, phase);
  vec3 ahead = prCurve(theta + 0.006, layer, phase);
  vec3 tangent = normalize(ahead - center);
  vec3 radial = normalize(center + vec3(0.001, 0.013, 0.007));
  vec3 side = normalize(cross(tangent, radial));
  vec3 surfaceNormal = normalize(cross(side, tangent));
  float twist = theta * (0.72 + uRibbonTwist * 0.58)
              + phase * 0.74 + layer * 1.17;
  vec3 ribbonDirection = normalize(
    side * cos(twist) + surfaceNormal * sin(twist));
  float widthEnvelope = (0.72 + 0.28
    * pow(sin(theta * 1.5 + phase + layer), 2.0))
    * mix(0.42, 1.0, sqrt(max(arcEnvelope, 0.0)));
  vec3 position = center
    + ribbonDirection * strip * uRibbonWidth * 0.5 * widthEnvelope;

  float pulse = sin(tt * 0.73 + layer * 1.71)
              + 0.44 * sin(tt * 1.17 + layer * 0.83 + 1.2);
  position *= 1.0 + uRibbonBreath * pulse * 0.16;
  float layerCenter = layer
    - (floor(clamp(uRibbonCount, 2.0, 6.0) + 0.5) - 1.0) * 0.5;
  position = prRotateY(
    position, layerCenter * 0.24 + sin(tt * 0.19 + layer * 1.3) * 0.055);
  position = prRotateX(
    position, layerCenter * 0.14 + cos(tt * 0.17 + layer * 0.9) * 0.04);
  position = prRotateY(position, tt * 0.105 + sin(tt * 0.21) * 0.11);
  position = prRotateX(position, -0.2 + sin(tt * 0.16 + layer * 0.1) * 0.16);

  float minSize = max(min(uSize.x, uSize.y), 1.0);
  float depthScale = 0.88 + position.z * 0.16;
  vec2 orbPosition = position.xy * uRadius * 1.45 * depthScale;
  vec2 clip = vec2(
    orbPosition.x * minSize / max(uSize.x, 1.0),
    orbPosition.y * minSize / max(uSize.y, 1.0));
  float canvasParticleScale = clamp(minSize / 640.0, 0.22, 1.0);
  float pointPixels = max(0.6, uParticleSize)
                    * (1.5 + uParticleBloom * 2.5)
                    * (0.92 + position.z * 0.18)
                    * canvasParticleScale;
  vec2 corner = corners[gl_VertexID];
  vec2 pointOffset = corner * pointPixels * 2.0
                   / max(uSize, vec2(1.0));

  if (!isActive) {
    gl_Position = vec4(2.0, 2.0, 1.0, 1.0);
    vLocal = corner;
    vColor = vec3(0.0);
    vOpacity = 0.0;
    return;
  }

  float colorPhase = uCoord * 0.32 + layer * 0.19 + phase * 0.025
                   + position.z * 0.08;
  float stripEdge = smoothstep(0.58, 1.0, abs(strip));
  float front = clamp(0.78 + position.z * 0.54, 0.5, 1.24);
  float baseOpacity = mix(0.025, 0.009,
    clamp(uShade / 1.5, 0.0, 1.0));

  gl_Position = vec4(clip + pointOffset,
                     clamp(0.5 - position.z * 0.12, 0.05, 0.95), 1.0);
  vLocal = corner;
  vColor = pow(
    mix(prPalette(colorPhase), uHighlightColor.xyz, stripEdge * 0.56),
    vec3(0.72)) * front;
  vOpacity = baseOpacity
    * (0.72 + stripEdge * 1.28)
    * arcEnvelope
    * pow(canvasParticleScale, 1.35);
}
`;

const RIBBON_FS = `#version 300 es
precision highp float;
${UNIFORM_BLOCK}
in vec2 vLocal;
in vec3 vColor;
in float vOpacity;
out vec4 fragColor;

void main() {
  float distanceSquared = dot(vLocal, vLocal);
  if (distanceSquared > 1.0) discard;
  float core = exp(-distanceSquared * 4.8);
  float halo = exp(-distanceSquared * 1.35);
  float bloom = clamp(uParticleBloom, 0.0, 2.0);
  // Web 端每层粒子数少于原生实现（12544 vs 36864），
  // 用 1.6× 亮度补偿采样密度，观感更接近原效果。
  float intensity = vOpacity * (core * 1.9 + halo * bloom * 0.72)
                  * max(uExposure, 0.0) * 1.6;
  float glowMix = clamp((halo - core * 0.45)
    * (0.18 + uEdgeGlow * 0.5), 0.0, 0.7);
  vec3 color = mix(vColor, uGlowColor.xyz, glowMix);
  float alpha = clamp(intensity, 0.0, 1.0);
  fragColor = vec4(color * alpha, alpha);
}
`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
${UNIFORM_BLOCK}
uniform sampler2D uRibbon;
out vec4 fragColor;

const float GL_CLEAR_EA = 0.995;
const float GL_CLEAR_EB = 1.04;

float mfEdgeD(float soft) { return soft - 0.005; }

vec3 mfEdgeGlow(vec3 col, vec2 uv, vec2 ctr, float rad,
                float soft, float glow, vec3 glowRGB) {
  if (glow <= 0.0) return col;
  float rr = length(uv - ctr);
  float outside = smoothstep(rad - max(soft, 0.0005),
                             rad + max(soft, 0.0005), rr);
  return col + (glowRGB
    * ((glow * exp(-(max(rr - rad, 0.0)) * 11.0)) * outside));
}

vec3 glsOver(vec3 dst, vec3 src, float a) {
  float k = clamp(a, 0.0, 1.0);
  return (src * k) + (dst * (1.0 - k));
}

float glsRefractionProfile(float t) {
  float depth = clamp(t, 0.0, 1.0);
  float circular = sqrt(max(1.0 - ((1.0 - depth) * (1.0 - depth)), 0.0));
  return 1.0 - circular;
}

float glsHighlightLobe(vec2 normal, vec2 direction, float cut, float power) {
  float angular = clamp((dot(normal, direction) - cut)
    / max(1.0 - cut, 0.001), 0.0, 1.0);
  return pow(angular, power);
}

vec2 glsContourWave(float angle, float t) {
  float wave = (sin((angle * 3.0) + (t * 0.62)) * 0.52)
             + (sin(((angle * 5.0) - (t * 0.41)) + 1.7) * 0.31)
             + (sin(((angle * 2.0) + (t * 0.23)) + 3.1) * 0.17);
  float slope = (cos((angle * 3.0) + (t * 0.62)) * 1.56)
              + (cos(((angle * 5.0) - (t * 0.41)) + 1.7) * 1.55)
              + (cos(((angle * 2.0) + (t * 0.23)) + 3.1) * 0.34);
  return vec2(wave, slope);
}

float glsContourStrength() {
  if (uStyle >= 18.5) return 0.11;
  return (uStyle >= 15.5) ? 0.16 : 0.09;
}

float glsContourScale(vec2 uv, float t, float amount) {
  if (amount <= 0.0) return 1.0;
  vec2 wave = glsContourWave(atan(uv.y, uv.x), t);
  return 1.0 + ((clamp(amount, 0.0, 1.0) * glsContourStrength()) * wave.x);
}

vec2 glsContourNormal(vec2 uv, float rad, float t, float amount) {
  float dist = length(uv);
  if (dist <= 0.0001) return vec2(0.0);
  vec2 radial = uv / vec2(dist);
  vec2 wave = glsContourWave(atan(uv.y, uv.x), t);
  float slope = (clamp(amount, 0.0, 1.0) * glsContourStrength()) * wave.y;
  vec2 tangent = vec2(-(radial.y), radial.x);
  return normalize(radial - (tangent * ((rad * slope) / dist)));
}

vec2 prTextureUvFromOrb(vec2 p, float contourRad) {
  float minSize = max(min(uSize.x, uSize.y), 1.0);
  vec2 fc = (p * contourRad * minSize + uSize) * 0.5;
  return clamp(vec2(fc.x / max(uSize.x, 1.0),
                    1.0 - fc.y / max(uSize.y, 1.0)),
               vec2(0.0), vec2(1.0));
}

void main() {
  vec2 pixel = gl_FragCoord.xy;
  float W = uSize.x;
  float H = uSize.y;
  float minSize = max(min(W, H), 1.0);
  vec2 tmUv = vec2(pixel.x / max(W, 1.0), pixel.y / max(H, 1.0));
  vec4 direct = texture(uRibbon, tmUv);
  if (uGlassEnabled <= 0.5) {
    fragColor = direct;
    return;
  }

  vec2 fc = vec2(pixel.x, H - pixel.y);
  vec2 uv = (2.0 * fc - uSize) / minSize;
  float rad = max(uRadius, 0.05);
  float t = uTime * uSpeed;
  float contourRad = rad * glsContourScale(uv, t, uContourDeform);

  if (length(uv) > contourRad * (1.01 + mfEdgeD(uEdgeSoftness))) {
    vec3 halo = mfEdgeGlow(vec3(0.0), uv, vec2(0.0), contourRad,
                           uEdgeSoftness, uEdgeGlow, uGlowColor.xyz);
    halo = clamp(halo, vec3(0.0), vec3(1.0));
    float alpha = max(halo.x, max(halo.y, halo.z));
    fragColor = vec4(halo, alpha);
    return;
  }

  vec2 p = uv / contourRad;
  float pd = length(p);
  float clearFa = 1.0 - smoothstep(GL_CLEAR_EA, GL_CLEAR_EB, pd);
  vec2 normal = glsContourNormal(uv, rad, t, uContourDeform);
  float edgeDepth = max(1.0 - pd, 0.0);
  float refractionWidth = 0.015 + 0.95 * clamp(uShellMidAlpha, 0.0, 1.0);
  float refractionT = edgeDepth / max(refractionWidth, 0.001);
  float refractionProfile = pow(glsRefractionProfile(refractionT), 0.68);
  float refractionAmount = 1.6 * clamp(uGlassOpacity, 0.0, 1.0)
                         * refractionProfile;
  vec2 refractedP = p - normal * refractionAmount;

  vec3 col = vec3(0.0);
  float surfaceWidth = 0.09 + 0.12 * clamp(uShellEdgeAlpha, 0.0, 1.0);
  float surfaceBand = (1.0 - smoothstep(0.0, surfaceWidth, edgeDepth)) * clearFa;
  float opticalRim = pow(surfaceBand, 1.3);
  float innerRimAlpha = opticalRim * uGlassOpacity * 0.14;
  col = glsOver(col, uShellInner.xyz, innerRimAlpha);

  vec2 coolDirection = normalize(vec2(0.84, 0.54));
  vec2 warmDirection = normalize(vec2(-0.62, -0.78));
  float coolSplit = glsHighlightLobe(normal, coolDirection, -0.32, 1.8);
  float warmSplit = glsHighlightLobe(normal, warmDirection, -0.28, 2.0);
  float dispersion = opticalRim * clamp(uGloss, 0.0, 2.0)
                   * (0.8 + 0.8 * uShellEdgeAlpha);
  col = glsOver(col, uShellMid.xyz, dispersion * coolSplit);
  col = glsOver(col, uShellEdge.xyz, dispersion * warmSplit);

  float edgeShadow = opticalRim * (0.015 + 0.15 * uShellEdgeAlpha)
                   * (0.15 + 0.85 * max(dot(normal, vec2(0.45, -0.89)), 0.0));
  col *= 1.0 - edgeShadow;

  vec2 keyDirection = normalize(vec2(-0.68, 0.73));
  vec2 fillDirection = normalize(vec2(0.74, -0.67));
  float key = opticalRim * glsHighlightLobe(normal, keyDirection, 0.2, 2.8)
            * clamp(uSheen, 0.0, 2.0) * 1.4;
  float fill = opticalRim * glsHighlightLobe(normal, fillDirection, 0.4, 3.6)
             * clamp(uSheen, 0.0, 2.0) * 1.0;
  col = glsOver(col, uSheenColor.xyz, key);
  col = glsOver(col, uSpecColor.xyz, fill);

  float ballA = 1.0 - smoothstep(
    0.99 - mfEdgeD(uEdgeSoftness),
    1.01 + mfEdgeD(uEdgeSoftness), pd);
  col = clamp(col * max(uExposure, 0.0), vec3(0.0), vec3(1.0)) * ballA;
  vec3 edged = mfEdgeGlow(col, uv, vec2(0.0), contourRad,
                          uEdgeSoftness, uEdgeGlow, uGlowColor.xyz);
  vec3 finalColor = clamp(edged, vec3(0.0), vec3(1.0));
  float emissionAlpha = max(finalColor.x, max(finalColor.y, finalColor.z));
  float sphereAlpha = clamp(max(ballA, emissionAlpha), 0.0, 1.0);
  // style 24 = particleRibbon：原实现走 particleGlassOverlay 分支，
  // 外壳 alpha 用 emissionAlpha（球心透明，粒子由折射采样透出），
  // 不能用 ballA，否则整个球心会成为不透明黑块。
  bool particleGlassOverlay = abs(uStyle - 24.0) < 0.5;
  float shellAlpha = particleGlassOverlay ? emissionAlpha : sphereAlpha;

  float channelSplit = 0.14 * clamp(uGloss, 0.0, 2.0)
                     * clamp(uGlassOpacity, 0.0, 1.0) * refractionProfile;
  vec4 redSample = texture(uRibbon, prTextureUvFromOrb(
    refractedP - normal * channelSplit, contourRad));
  vec4 greenSample = texture(uRibbon, prTextureUvFromOrb(
    refractedP, contourRad));
  vec4 blueSample = texture(uRibbon, prTextureUvFromOrb(
    refractedP + normal * channelSplit, contourRad));
  float refractedAlpha = max(redSample.w, max(greenSample.w, blueSample.w))
    * clearFa;
  vec4 refracted = vec4(
    vec3(redSample.x, greenSample.y, blueSample.z) * clearFa,
    refractedAlpha);

  fragColor = vec4(
    finalColor + refracted.xyz * (1.0 - shellAlpha),
    shellAlpha + refracted.w * (1.0 - shellAlpha));
}
`;

function srgbToLinear(v) {
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v) {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

function mixSrgb(from, to, progress) {
  return linearToSrgb(
    srgbToLinear(from) + (srgbToLinear(to) - srgbToLinear(from)) * progress
  );
}

function compile(gl, type, source, label) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    console.error(`[assistantOrb] ${label} shader compile failed:\n${log}`);
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function buildProgram(gl, vsSource, fsSource, label) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSource, `${label} vertex`);
  if (!vs) return null;
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource, `${label} fragment`);
  if (!fs) { gl.deleteShader(vs); return null; }
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error(`[assistantOrb] ${label} link failed: ${gl.getProgramInfoLog(program)}`);
    gl.deleteProgram(program);
    return null;
  }
  const blockIndex = gl.getUniformBlockIndex(program, 'Uniforms');
  if (blockIndex !== gl.INVALID_INDEX) {
    gl.uniformBlockBinding(program, blockIndex, 0);
  }
  return program;
}

function seedFor(state) {
  return state === 'thinking' ? THINKING_SEED : IDLE_SEED;
}

/**
 * 在 canvas 上创建 Liquid Orb。返回 null 表示 WebGL2 不可用/着色器失败。
 * @param {HTMLCanvasElement} canvas
 */
export function createOrb(canvas) {
  if (!canvas || IDLE_SEED.length !== SEED_LEN || THINKING_SEED.length !== SEED_LEN) {
    return null;
  }
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false
    });
  } catch (e) {
    gl = null;
  }
  if (!gl) return null;

  const ribbonProgram = buildProgram(gl, RIBBON_VS, RIBBON_FS, 'ribbon');
  const compositeProgram = buildProgram(gl, `#version 300 es
precision highp float;
${UNIFORM_BLOCK}
out vec2 vUv;
void main() {
  vec2 pos[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  gl_Position = vec4(pos[gl_VertexID], 0.0, 1.0);
}
`, COMPOSITE_FS, 'composite');
  if (!ribbonProgram || !compositeProgram) {
    if (ribbonProgram) gl.deleteProgram(ribbonProgram);
    if (compositeProgram) gl.deleteProgram(compositeProgram);
    return null;
  }

  const ubo = gl.createBuffer();
  gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
  gl.bufferData(gl.UNIFORM_BUFFER, new Float32Array(SEED_LEN), gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.UNIFORM_BUFFER, null);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);

  const emptyVao = gl.createVertexArray();
  const ribbonTexture = gl.createTexture();
  let fbo = null;
  let texW = 0;
  let texH = 0;

  const uniforms = new Float32Array(IDLE_SEED);
  const displayed = IDLE_SEED.slice();
  let fromUniforms = IDLE_SEED.slice();
  let targetUniforms = IDLE_SEED.slice();
  let transitionTarget = 'idle';
  let transitionStartedAt = 0;
  let transitionDuration = 0;
  let currentState = 'idle';

  let raf = 0;
  let running = false;
  let disposed = false;
  let lastAt = 0;
  let motionPhase = 0;
  let resizeObserver = null;

  function resize() {
    // 固定至少 2× 内部分辨率：96px 球在 1× 屏上也有足够像素承载细粒子。
    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 2), 2);
    const cssW = Math.max(1, canvas.clientWidth || 96);
    const cssH = Math.max(1, canvas.clientHeight || 96);
    const w = Math.max(16, Math.round(cssW * dpr));
    const h = Math.max(16, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (fbo && texW === w && texH === h) return;
    texW = w;
    texH = h;
    if (fbo) gl.deleteFramebuffer(fbo);
    gl.bindTexture(gl.TEXTURE_2D, ribbonTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D, ribbonTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function sampleTransition(now) {
    const raw = transitionDuration === 0
      ? 1
      : Math.min(1, Math.max(0, (now - transitionStartedAt) / transitionDuration));
    const eased = transitionTarget === 'thinking'
      ? 1 - Math.pow(1 - raw, 3)
      : raw * raw * (3 - 2 * raw);
    for (let i = 3; i < SEED_LEN; i++) {
      const isColor = i >= 40 && (i - 40) % 4 < 3;
      displayed[i] = isColor
        ? mixSrgb(fromUniforms[i], targetUniforms[i], eased)
        : fromUniforms[i] + (targetUniforms[i] - fromUniforms[i]) * eased;
    }
    return displayed;
  }

  function setState(next) {
    if (next !== 'thinking') next = 'idle';
    if (next === currentState) return;
    const now = performance.now() / 1000;
    fromUniforms = sampleTransition(now).slice();
    targetUniforms = seedFor(next).slice();
    transitionTarget = next;
    transitionStartedAt = now;
    transitionDuration = next === 'thinking' ? ACTIVATION : SETTLE;
    currentState = next;
  }

  function drawFrame(timestamp) {
    if (disposed) return;
    raf = requestAnimationFrame(drawFrame);
    if (!canvas.isConnected || canvas.width === 0) return;
    const now = timestamp / 1000;
    const state = sampleTransition(now);
    const dt = lastAt ? Math.min(0.1, Math.max(0, now - lastAt)) : 0;
    lastAt = now;
    motionPhase += dt * Math.max(state[3], 0);
    uniforms.set(state);
    uniforms[0] = canvas.width;
    uniforms[1] = canvas.height;
    uniforms[2] = motionPhase / Math.max(state[3], 0.001);

    gl.bindBuffer(gl.UNIFORM_BUFFER, ubo);
    gl.bufferSubData(gl.UNIFORM_BUFFER, 0, uniforms);
    gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, ubo);

    // ---- ribbon pass ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, texW, texH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(ribbonProgram);
    gl.bindVertexArray(emptyVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, INSTANCE_COUNT);

    // ---- composite pass ----
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(compositeProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ribbonTexture);
    const loc = gl.getUniformLocation(compositeProgram, 'uRibbon');
    if (loc) gl.uniform1i(loc, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  function start() {
    if (running || disposed) return;
    resize();
    running = true;
    lastAt = 0;
    raf = requestAnimationFrame(drawFrame);
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(canvas);
    }
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
    if (resizeObserver) resizeObserver.disconnect();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (fbo) gl.deleteFramebuffer(fbo);
    gl.deleteTexture(ribbonTexture);
    gl.deleteVertexArray(emptyVao);
    gl.deleteBuffer(ubo);
    gl.deleteProgram(ribbonProgram);
    gl.deleteProgram(compositeProgram);
    // 释放 WebGL 上下文：组件在路由切换时会反复挂载/卸载，
    // 不主动丢失上下文会累积到浏览器的上下文数量上限。
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
  }

  const onVisibility = () => {
    if (document.hidden) stop();
    else start();
  };
  document.addEventListener('visibilitychange', onVisibility);

  return {
    start,
    stop,
    dispose,
    setState,
    resize,
    getState: () => currentState
  };
}
