# Local face models

The face-labeling tool downloads two pinned OpenCV Zoo models into the ignored
`.media-staging/faces/models/` directory. Model bytes, face crops, embeddings,
and the labeling database are never committed or deployed.

| Purpose | Model | License | SHA-256 |
| --- | --- | --- | --- |
| Detection | [YuNet `face_detection_yunet_2023mar.onnx`](https://github.com/opencv/opencv_zoo/blob/4.10.0/models/face_detection_yunet/face_detection_yunet_2023mar.onnx) | [MIT](https://github.com/opencv/opencv_zoo/blob/4.10.0/models/face_detection_yunet/LICENSE) | `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4` |
| Embedding | [SFace `face_recognition_sface_2021dec.onnx`](https://github.com/opencv/opencv_zoo/blob/4.10.0/models/face_recognition_sface/face_recognition_sface_2021dec.onnx) | [Apache-2.0](https://github.com/opencv/opencv_zoo/blob/4.10.0/models/face_recognition_sface/LICENSE) | `0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79` |

The Python runtime uses
[`opencv-python-headless`](https://pypi.org/project/opencv-python-headless/4.13.0.92/)
and NumPy at the exact versions in `requirements.txt`.

Face similarity is only a review aid. Automatic clusters are deliberately
conservative and never assign real-world names.
