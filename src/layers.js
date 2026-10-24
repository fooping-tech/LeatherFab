export const defaultLayer = () => ({
  id: "layer-default",
  name: "レイヤー 1",
  visible: true,
  locked: false,
});
export function ensureLayers(project) {
  if (!project.layers?.length) project.layers = [defaultLayer()];
  const ids = new Set(project.layers.map((l) => l.id));
  for (const item of project.items)
    if (!ids.has(item.layerId)) item.layerId = project.layers[0].id;
  project.version = 2;
  return project;
}
export function layerOf(project, item) {
  return project.layers?.find((l) => l.id === item.layerId);
}
// Hidden items (item.hidden) and items on hidden layers are not drawn, cut
// or exported; a scoped bridge follows its owner.
export function isVisible(project, item) {
  if (item.hidden || layerOf(project, item)?.visible === false) return false;
  const owner =
    item.targetId && project.items.find((i) => i.id === item.targetId);
  return !owner || (!owner.hidden && layerOf(project, owner)?.visible !== false);
}
export function isEditable(project, item) {
  if (!item || !isVisible(project, item) || layerOf(project, item)?.locked)
    return false;
  const owner =
    item.targetId && project.items.find((i) => i.id === item.targetId);
  return !owner || !layerOf(project, owner)?.locked;
}
export function visibleItems(project) {
  return project.layers
    ? project.layers.flatMap((l) =>
        project.items.filter(
          (i) => i.layerId === l.id && isVisible(project, i),
        ),
      )
    : project.items;
}
