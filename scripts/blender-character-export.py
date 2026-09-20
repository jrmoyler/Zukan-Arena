"""Export an authored character. Run inside Blender, never generate substitute meshes.
blender character.blend --background --python scripts/blender-character-export.py -- output.glb
"""
import bpy
import sys
from pathlib import Path

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
if len(args) != 1:
    raise RuntimeError('Pass one output GLB path after --')
required_actions = {'idle', 'run', 'cast', 'hit', 'ko'}
actions = {action.name for action in bpy.data.actions}
if not required_actions.issubset(actions):
    raise RuntimeError(f'Missing authored actions: {required_actions - actions}')
for name in ['socket_ability', 'socket_head', 'socket_core']:
    if name not in bpy.data.objects:
        raise RuntimeError(f'Missing named attachment: {name}')
meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
if not meshes or not any(mod.type == 'ARMATURE' for obj in meshes for mod in obj.modifiers):
    raise RuntimeError('Character needs authored mesh geometry and an armature modifier')
for obj in meshes:
    if not obj.data.uv_layers:
        raise RuntimeError(f'{obj.name} has no UV map')
    if not obj.data.materials:
        raise RuntimeError(f'{obj.name} has no authored material')
output = str(Path(args[0]).resolve())
bpy.ops.export_scene.gltf(filepath=output, export_format='GLB', use_selection=False,
    export_animations=True, export_skins=True, export_yup=True)
print(f'Exported {output}. Run character preparation, glTF validation and visual review before approval.')
