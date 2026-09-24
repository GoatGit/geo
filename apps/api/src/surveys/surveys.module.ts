import { PersonaLibraryController } from './persona-library.controller';
import { PersonaLibraryService } from './persona-library.service';
import { CalibrationService } from './calibration.service';
import { Module } from '@nestjs/common';
import { SurveysController } from './surveys.controller';
import { SurveysService } from './surveys.service';

@Module({
  controllers: [SurveysController, PersonaLibraryController],
  providers: [SurveysService, PersonaLibraryService, CalibrationService],
  exports: [SurveysService],
})
export class SurveysModule {}
