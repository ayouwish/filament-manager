#!/usr/bin/env python3
"""生成测试/演示用的 .3mf 夹具（Bambu Studio 打印配置结构）。

用法：python3 tools/make_fixture_3mf.py
产物：
  test/fixtures/sliced.3mf     已切片，含 Metadata/slice_info.config（精确克重）
  test/fixtures/unsliced.3mf   未切片，只有 project_settings.config
  data/examples/sample-3mf.3mf 演示用（同 sliced，文件名更友好）
"""
from __future__ import annotations

import json
import pathlib
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "test" / "fixtures"
EXAMPLES = ROOT / "data" / "examples"

SLICE_INFO = """<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="01.10.00.89"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="4823"/>
    <metadata key="weight" value="165.6"/>
    <metadata key="support_used" value="false"/>
    <filament id="1" tray_info_idx="GFA00" type="PLA" color="#17181A" used_m="4.823" used_g="120.4"/>
    <filament id="2" tray_info_idx="GFA01" type="PLA" color="#F2F2EEFF" used_m="1.432" used_g="45.2"/>
  </plate>
  <plate>
    <metadata key="index" value="2"/>
    <metadata key="prediction" value="1800"/>
    <metadata key="weight" value="60.3"/>
    <metadata key="support_used" value="false"/>
    <filament id="1" tray_info_idx="GFG00" type="PETG" color="#E0A030" used_m="2.100" used_g="60.3"/>
  </plate>
</config>
"""

PROJECT_SETTINGS = {
    "printer_model": "Bambu Lab A1",
    "printer_variant": "0.4",
    "filament_type": ["PLA", "PLA"],
    "filament_colour": ["#17181A", "#F2F2EE"],
    "filament_ids": ["GFA00", "GFA01"],
    "filament_settings_id": ["Bambu PLA Basic @BBL A1", "Bambu PLA Matte @BBL A1"],
    "filament_density": ["1.24", "1.24"],
    "filament_diameter": ["1.75", "1.75"],
    "enable_support": "0",
}

MODEL_SETTINGS = """<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value="灯罩"/>
    <metadata key="gcode_file" value="Metadata/plate_1.gcode"/>
  </plate>
  <plate>
    <metadata key="plater_id" value="2"/>
    <metadata key="plater_name" value="底座"/>
    <metadata key="gcode_file" value="Metadata/plate_2.gcode"/>
  </plate>
</config>
"""

MODEL_XML = """<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <metadata name="Application">BambuStudio-01.10.00.89</metadata>
  <resources><object id="1" type="model"><mesh><vertices/><triangles/></mesh></object></resources>
  <build><item objectid="1"/></build>
</model>
"""


def write_3mf(path: pathlib.Path, files: dict[str, bytes]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)


def main() -> None:
    settings = json.dumps(PROJECT_SETTINGS, indent=2).encode()
    common = {
        "3D/3dmodel.model": MODEL_XML.encode(),
        "Metadata/project_settings.config": settings,
        "Metadata/model_settings.config": MODEL_SETTINGS.encode(),
    }
    sliced = dict(common)
    sliced["Metadata/slice_info.config"] = SLICE_INFO.encode()
    sliced["Metadata/plate_1.gcode"] = b"; gcode placeholder\n"
    sliced["Metadata/plate_2.gcode"] = b"; gcode placeholder\n"

    write_3mf(FIXTURES / "sliced.3mf", sliced)
    write_3mf(FIXTURES / "unsliced.3mf", common)
    write_3mf(EXAMPLES / "sample-multicolor.3mf", sliced)
    print(f"written: {FIXTURES / 'sliced.3mf'}")
    print(f"written: {FIXTURES / 'unsliced.3mf'}")
    print(f"written: {EXAMPLES / 'sample-multicolor.3mf'}")


if __name__ == "__main__":
    main()
