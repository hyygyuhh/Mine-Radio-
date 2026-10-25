const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./pixi-nYvjsmWU.js","./rolldown-runtime-hePW80VL.js"])))=>i.map(i=>d[i]);
import{n as e}from"./pixi-nYvjsmWU.js";var t=Symbol.for(`folia.pixi821FilterPoolCompat`),n=e=>{if(e.VERSION!==`8.21.0`)return;let n=e.FilterSystem.prototype;if(n[t])return;n[t]=!0;let r=new Set,i=e.TexturePool,a=()=>{let t=e.Texture.EMPTY.source;r.forEach(e=>{e.setResource(t,1),e.setResource(t.style,2),e.setResource(t,3)})},o=n.init;n.init=function(){o?.call(this),r.add(this._globalFilterBindGroup)};let s=n.destroy;n.destroy=function(){r.delete(this._globalFilterBindGroup),this._globalFilterBindGroup.destroy(),s.call(this)};let c=n.push;n.push=function(e){let t=this._filterStack[this._filterStackIndex];t&&(t.inputTexture=null),c.call(this,e)};let l=i._dropTextures;i._dropTextures=function(e,t){t&&e.length>0&&a(),l.call(this,e,t)};let u=i.returnTexture;i.returnTexture=function(e,t){let n=this._poolKey[e.uid];n!==void 0&&!this._buckets.has(n)&&a(),u.call(this,e,t)}},r=async()=>{let t=await e(()=>import(`./pixi-nYvjsmWU.js`).then(e=>e.t),__vite__mapDeps([0,1]),import.meta.url);return t.GlProgram.defaultOptions.preferredFragmentPrecision=`highp`,n(t),t},i=`
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

void main(void) {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    gl_Position = vec4(position, 0.0, 1.0);
    vTextureCoord = aPosition * (uOutputFrame.zw * uInputSize.zw);
}
`;export{r as n,i as t};